// Package capture persists realtime interactions (reactions, hands, stage changes) off the
// request path: callers hand events to a bounded in-process buffer and a single writer
// flushes them to the database in batches.
package capture

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

type Kind string

const (
	Reaction  Kind = "reaction"
	HandRaise Kind = "hand_raise"
	HandLower Kind = "hand_lower"
	StageOn   Kind = "stage_on"
	StageOff  Kind = "stage_off"
)

type Event struct {
	Slug     string
	Identity string
	Kind     Kind
	Emoji    string
	At       time.Time
}

// Sink writes one batch. Implemented by the store with a single COPY.
type Sink interface {
	InsertEngagementEvents(ctx context.Context, batch []Event) error
}

type Config struct {
	// Buffer bounds memory: events beyond it are dropped and counted, never queued.
	Buffer     int
	BatchSize  int
	FlushEvery time.Duration
	// ReactionsPerMin and HandsPerMin cap what one person can write per webinar. The relay
	// itself is limited separately (sayPerMin); this only bounds what is stored.
	ReactionsPerMin int
	HandsPerMin     int
	WriteTimeout    time.Duration
}

func DefaultConfig() Config {
	return Config{
		Buffer:          16384,
		BatchSize:       1000,
		FlushEvery:      time.Second,
		ReactionsPerMin: 30,
		HandsPerMin:     10,
		WriteTimeout:    5 * time.Second,
	}
}

type Stats struct {
	Accepted uint64
	Limited  uint64
	Dropped  uint64
	Written  uint64
	Failed   uint64
}

type Recorder struct {
	cfg  Config
	sink Sink
	log  *slog.Logger
	now  func() time.Time

	events  chan Event
	flushes chan chan error
	stop    chan struct{}
	done    chan struct{}
	closed  atomic.Bool
	once    sync.Once

	reactions *window
	hands     *window

	accepted, limited, dropped, written, failed atomic.Uint64
	lastWarn                                    atomic.Int64
}

func New(sink Sink, cfg Config, log *slog.Logger) *Recorder {
	d := DefaultConfig()
	if cfg.Buffer <= 0 {
		cfg.Buffer = d.Buffer
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = d.BatchSize
	}
	if cfg.FlushEvery <= 0 {
		cfg.FlushEvery = d.FlushEvery
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = d.WriteTimeout
	}
	r := &Recorder{
		cfg:       cfg,
		sink:      sink,
		log:       log,
		now:       time.Now,
		events:    make(chan Event, cfg.Buffer),
		flushes:   make(chan chan error),
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
		reactions: newWindow(cfg.ReactionsPerMin, time.Minute),
		hands:     newWindow(cfg.HandsPerMin, time.Minute),
	}
	go r.run()
	return r
}

// Record queues one event and never blocks. It reports whether the event was kept.
func (r *Recorder) Record(e Event) bool {
	if r == nil || r.closed.Load() || e.Slug == "" || e.Identity == "" {
		return false
	}
	if e.At.IsZero() {
		e.At = r.now()
	}
	if !r.allow(e) {
		r.limited.Add(1)
		return false
	}
	select {
	case r.events <- e:
		r.accepted.Add(1)
		return true
	default:
		r.dropped.Add(1)
		r.warn("engagement capture: buffer full, dropping event")
		return false
	}
}

func (r *Recorder) allow(e Event) bool {
	key := e.Slug + "\x00" + e.Identity
	switch e.Kind {
	case Reaction:
		return r.reactions.allow(key, e.At)
	case HandRaise, HandLower:
		return r.hands.allow(key, e.At)
	}
	return true
}

// Flush writes everything queued so far and waits for it, so a reader computing
// engagement sees the events this process has accepted.
func (r *Recorder) Flush(ctx context.Context) error {
	if r == nil || r.closed.Load() {
		return nil
	}
	reply := make(chan error, 1)
	select {
	case r.flushes <- reply:
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-reply:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close stops accepting events, drains the buffer and writes it. Safe to call twice.
func (r *Recorder) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		r.closed.Store(true)
		close(r.stop)
	})
	select {
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Recorder) Stats() Stats {
	if r == nil {
		return Stats{}
	}
	return Stats{
		Accepted: r.accepted.Load(),
		Limited:  r.limited.Load(),
		Dropped:  r.dropped.Load(),
		Written:  r.written.Load(),
		Failed:   r.failed.Load(),
	}
}

func (r *Recorder) run() {
	defer close(r.done)
	tick := time.NewTicker(r.cfg.FlushEvery)
	defer tick.Stop()
	batch := make([]Event, 0, r.cfg.BatchSize)

	for {
		select {
		case e := <-r.events:
			batch = append(batch, e)
			if len(batch) >= r.cfg.BatchSize {
				batch = r.write(batch)
			}
		case <-tick.C:
			batch = r.write(batch)
		case reply := <-r.flushes:
			batch = r.drain(batch)
			reply <- r.writeErr(batch)
			batch = batch[:0]
		case <-r.stop:
			batch = r.drain(batch)
			_ = r.writeErr(batch)
			return
		}
	}
}

// drain moves whatever is queued into batch, writing full batches as it goes.
func (r *Recorder) drain(batch []Event) []Event {
	for {
		select {
		case e := <-r.events:
			batch = append(batch, e)
			if len(batch) >= r.cfg.BatchSize {
				batch = r.write(batch)
			}
		default:
			return batch
		}
	}
}

func (r *Recorder) write(batch []Event) []Event {
	_ = r.writeErr(batch)
	return batch[:0]
}

/* writeErr writes one batch, retrying once. A batch that still fails is dropped and
 * counted: holding it would let a database outage grow memory without bound, and these
 * events are analytics, not the transcript. */
func (r *Recorder) writeErr(batch []Event) error {
	if len(batch) == 0 {
		return nil
	}
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), r.cfg.WriteTimeout)
		err = r.sink.InsertEngagementEvents(ctx, batch)
		cancel()
		if err == nil {
			r.written.Add(uint64(len(batch)))
			return nil
		}
		if errors.Is(err, context.Canceled) {
			break
		}
	}
	r.failed.Add(uint64(len(batch)))
	r.warn("engagement capture: batch write failed", "events", len(batch), "error", err)
	return err
}

// warn logs at most once every ten seconds, so an overload does not become a log flood.
func (r *Recorder) warn(msg string, args ...any) {
	if r.log == nil {
		return
	}
	now := r.now().UnixNano()
	last := r.lastWarn.Load()
	if now-last < int64(10*time.Second) || !r.lastWarn.CompareAndSwap(last, now) {
		return
	}
	s := r.Stats()
	r.log.Warn(msg, append(args, "dropped", s.Dropped, "failed", s.Failed, "limited", s.Limited)...)
}

// window is a fixed-window counter per key with an opportunistic sweep, so the map is
// bounded by the number of people active in the last window.
type window struct {
	mu     sync.Mutex
	limit  int
	per    time.Duration
	hits   map[string]*slot
	lastGC time.Time
}

type slot struct {
	count int
	reset time.Time
}

func newWindow(limit int, per time.Duration) *window {
	return &window{limit: limit, per: per, hits: map[string]*slot{}}
}

func (w *window) allow(key string, now time.Time) bool {
	if w.limit <= 0 {
		return true
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if now.Sub(w.lastGC) > w.per {
		for k, s := range w.hits {
			if now.After(s.reset) {
				delete(w.hits, k)
			}
		}
		w.lastGC = now
	}
	s, ok := w.hits[key]
	if !ok || now.After(s.reset) {
		w.hits[key] = &slot{count: 1, reset: now.Add(w.per)}
		return true
	}
	if s.count >= w.limit {
		return false
	}
	s.count++
	return true
}
