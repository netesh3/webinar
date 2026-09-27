// Package service decides when a webinar's engagement is computed and serves it: from the
// stored snapshot when it is fresh, otherwise by computing once per webinar no matter how
// many requests are waiting for it.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/engagement"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

type Store interface {
	EngagementInput(ctx context.Context, webinarID string, now time.Time) (engagement.Input, error)
	EngagementSnapshot(ctx context.Context, webinarID string, version int) (store.EngagementSnapshot, error)
	SaveEngagement(ctx context.Context, webinarID string, version int, computedAt time.Time, summary []byte, rows []engagement.Scored) (bool, error)
}

// Flusher makes captured-but-unwritten events visible before a compute reads them.
type Flusher interface {
	Flush(ctx context.Context) error
}

type Config struct {
	// LiveTTL is how old a live webinar's snapshot may be before a request recomputes it.
	LiveTTL        time.Duration
	ComputeTimeout time.Duration
}

type Service struct {
	store   Store
	flusher Flusher
	cfg     Config
	log     *slog.Logger
	now     func() time.Time

	mu       sync.Mutex
	inflight map[string]*call
}

type call struct {
	done    chan struct{}
	payload []byte
	err     error
}

func New(st Store, flusher Flusher, cfg Config, log *slog.Logger) *Service {
	if cfg.LiveTTL <= 0 {
		cfg.LiveTTL = 30 * time.Second
	}
	if cfg.ComputeTimeout <= 0 {
		cfg.ComputeTimeout = 15 * time.Second
	}
	return &Service{store: st, flusher: flusher, cfg: cfg, log: log, now: time.Now, inflight: map[string]*call{}}
}

/* Summary is the webinar's summary document as JSON, ready to write to a response.
 *
 * A webinar that has not started is computed on the spot and not stored: there is nothing
 * to read and nothing worth keeping. Otherwise the stored snapshot is served while it is
 * fresh — for an ended webinar, computed after it ended; for a live one, younger than
 * LiveTTL — and recomputed through Compute when it is not. The per-attendee rows are
 * written in the same transaction, so the attendee endpoints may rely on a fresh summary
 * meaning fresh rows.
 */
func (s *Service) Summary(ctx context.Context, w store.EngagementWebinar) ([]byte, error) {
	f := engagement.Current()
	if w.StartedAt == nil {
		in, err := s.store.EngagementInput(ctx, w.ID, s.now())
		if err != nil {
			return nil, err
		}
		return json.Marshal(engagement.Compute(in, f).Summary)
	}
	snap, err := s.store.EngagementSnapshot(ctx, w.ID, f.Version)
	if err == nil && s.fresh(w, snap.ComputedAt) {
		return snap.Payload, nil
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	return s.Compute(ctx, w)
}

func (s *Service) fresh(w store.EngagementWebinar, computed time.Time) bool {
	if w.Status == string(types.StatusEnded) && w.EndedAt != nil {
		return !computed.Before(*w.EndedAt)
	}
	return s.now().Sub(computed) < s.cfg.LiveTTL
}

/* Compute recomputes and stores the webinar's engagement, sharing one computation among
 * every caller that arrives while it runs. It runs on its own context so the first caller
 * hanging up does not cancel it for the others; each caller still stops waiting when its
 * own context ends. */
func (s *Service) Compute(ctx context.Context, w store.EngagementWebinar) ([]byte, error) {
	s.mu.Lock()
	c, ok := s.inflight[w.ID]
	if !ok {
		c = &call{done: make(chan struct{})}
		s.inflight[w.ID] = c
		go s.run(w, c)
	}
	s.mu.Unlock()

	select {
	case <-c.done:
		return c.payload, c.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Service) run(w store.EngagementWebinar, c *call) {
	defer func() {
		s.mu.Lock()
		delete(s.inflight, w.ID)
		s.mu.Unlock()
		close(c.done)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.ComputeTimeout)
	defer cancel()
	c.payload, c.err = s.compute(ctx, w)
	if c.err != nil && s.log != nil {
		s.log.Error("engagement: compute failed", "webinar", w.Slug, "error", c.err)
	}
}

func (s *Service) compute(ctx context.Context, w store.EngagementWebinar) ([]byte, error) {
	if s.flusher != nil {
		if err := s.flusher.Flush(ctx); err != nil && s.log != nil {
			s.log.Warn("engagement: flush before compute failed", "error", err)
		}
	}
	started := time.Now()
	now := s.now()
	in, err := s.store.EngagementInput(ctx, w.ID, now)
	if err != nil {
		return nil, err
	}
	loaded := time.Since(started)
	f := engagement.Current()
	res := engagement.Compute(in, f)
	payload, err := json.Marshal(res.Summary)
	if err != nil {
		return nil, err
	}
	if res.Summary.State != types.EngagementNotStarted {
		if _, err := s.store.SaveEngagement(ctx, w.ID, f.Version, now, payload, res.Rows); err != nil {
			return nil, err
		}
	}
	if s.log != nil {
		s.log.Info("engagement computed", "webinar", w.Slug, "attendees", len(res.Rows),
			"load_ms", loaded.Milliseconds(), "total_ms", time.Since(started).Milliseconds(),
			"bytes", len(payload))
	}
	return payload, nil
}
