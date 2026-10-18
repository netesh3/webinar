package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Channel is the one Postgres NOTIFY channel every instance listens on. The webinar is in
// the payload, so one LISTEN connection per instance serves every webinar.
const Channel = "webcast_realtime"

/* MaxPayload is the largest envelope sent through NOTIFY.
 *
 * Postgres refuses payloads of 8000 bytes or more. Anything bigger (a long chat message with
 * every mention resolved, a large room metadata blob) is sent as a KindRefetch for its packet
 * kind instead, and the browser reads the full item from the HTTP backlog it already uses to
 * catch up after a reconnect. */
const MaxPayload = 7800

// Notifier sends one NOTIFY. The store implements it (store.PGNotify).
type Notifier interface {
	PGNotify(ctx context.Context, channel, payload string) error
}

/* Bus publishes events to every instance and feeds what arrives into the local Hub.
 *
 * With no Notifier (a single process, the tests) Publish dispatches locally and nothing
 * listens. With one, Publish only NOTIFYs; delivery to local subscribers happens when the
 * notification comes back on this instance's own LISTEN connection, so a viewer on this
 * instance and one on another get the event the same way and exactly once. */
type Bus struct {
	hub     *Hub
	notify  Notifier
	connect func(ctx context.Context) (*pgx.Conn, error)
	log     *slog.Logger

	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
}

// NewBus wires a hub to Postgres. notify and connect may both be nil for a local-only bus.
func NewBus(hub *Hub, notify Notifier, connect func(ctx context.Context) (*pgx.Conn, error), log *slog.Logger) *Bus {
	if log == nil {
		log = slog.Default()
	}
	return &Bus{hub: hub, notify: notify, connect: connect, log: log}
}

// Hub returns the bus's local hub.
func (b *Bus) Hub() *Hub { return b.hub }

// Fit returns e unchanged when its envelope is small enough for NOTIFY, and otherwise the
// KindRefetch event that stands in for it.
func Fit(e Event) (Event, []byte, error) {
	raw, err := json.Marshal(e)
	if err != nil {
		return Event{}, nil, err
	}
	if len(raw) <= MaxPayload {
		return e, raw, nil
	}
	kind := e.Kind
	if e.Kind == KindPacket {
		var head struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(e.Data, &head) == nil && head.Kind != "" {
			kind = head.Kind
		}
	}
	data, _ := json.Marshal(map[string]string{"kind": kind})
	small := Event{Slug: e.Slug, Kind: KindRefetch, To: e.To, Data: data}
	raw, err = json.Marshal(small)
	if err != nil {
		return Event{}, nil, err
	}
	if len(raw) > MaxPayload {
		// Only a recipient list longer than any real one gets here. Everyone refetches.
		small.To = nil
		raw, err = json.Marshal(small)
	}
	return small, raw, err
}

/* Publish sends e to every instance's subscribers.
 *
 * A failed NOTIFY falls back to local delivery and is logged: viewers on this instance still
 * get the event, and the others catch up on their next backlog fetch. Publishing is never an
 * error for the caller, because every caller is already doing the real work (a chat row, a
 * LiveKit packet) and must not fail because this side path did. */
func (b *Bus) Publish(ctx context.Context, e Event) {
	e, raw, err := Fit(e)
	if err != nil {
		b.log.Warn("realtime: could not encode event", "slug", e.Slug, "error", err)
		return
	}
	if b.notify == nil {
		b.hub.Dispatch(e)
		return
	}
	if err := b.notify.PGNotify(ctx, Channel, string(raw)); err != nil {
		b.log.Warn("realtime: notify failed, delivering locally only", "slug", e.Slug, "error", err)
		b.hub.Dispatch(e)
	}
}

/* Start opens this instance's LISTEN connection, once. Called by the hub when its first
 * subscriber arrives, so an instance with no edge viewers holds no extra database connection.
 * The connection is dedicated, not borrowed from the pool: LISTEN pins a session for as long
 * as it runs, and the pool is deliberately small. */
func (b *Bus) Start() {
	if b.connect == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.running {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.running, b.cancel = true, cancel
	go b.listen(ctx)
}

// Close stops the listener. Safe to call when it never started.
func (b *Bus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.cancel != nil {
		b.cancel()
	}
	b.running = false
}

func (b *Bus) listen(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := b.listenOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		b.log.Warn("realtime: listener lost, reconnecting", "error", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (b *Bus) listenOnce(ctx context.Context) error {
	conn, err := b.connect(ctx)
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{Channel}.Sanitize()); err != nil {
		return err
	}
	b.log.Info("realtime: listening", "channel", Channel)
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var e Event
		if err := json.Unmarshal([]byte(n.Payload), &e); err != nil || e.Slug == "" {
			continue
		}
		b.hub.Dispatch(e)
	}
}
