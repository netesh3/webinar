/*
Package realtime fans session events out to browsers that are not connected to LiveKit.

Edge delivery (docs/edge-delivery.md) puts the audience on an LL-HLS feed instead of the
video server, which means they no longer receive the LiveKit data channel and room metadata
that carry chat, polls, controls and stage invites. This package is the replacement path: the
API publishes the same packets here, and GET /api/webinars/{slug}/events streams them to each
viewer as server-sent events.

Two layers:

  - Hub is per process: who is subscribed to which webinar, and a non-blocking dispatch that
    drops a subscriber whose buffer is full rather than letting one slow browser hold up the
    room.
  - Bus carries an Event between processes. Cloud Run runs several instances and a viewer is
    connected to only one of them, so a chat message accepted by instance A has to reach the
    viewers on instance B. The production bus is Postgres LISTEN/NOTIFY (see PGBus); a bus
    that only dispatches locally is what a single process and the tests use.
*/
package realtime

import (
	"encoding/json"
	"sync"
	"time"
)

// Event kinds on the wire. They are also the SSE `event:` names the browser listens for.
const (
	// KindPacket is a LiveKit data-channel packet, byte for byte what the stage receives on
	// the `webcast` topic, so the browser parses both with the same code.
	KindPacket = "packet"
	// KindMeta is the room metadata JSON (types.RoomMeta): controls, status, topic, recording.
	KindMeta = "meta"
	// KindRefetch says "something of this kind happened but was too large to carry" — the
	// browser refetches the matching backlog over HTTP. Data is {"kind": "<packet kind>"}.
	KindRefetch = "refetch"
	/* KindBye ends the streams of the identities in To that opened before the time in Data
	 * ({"before": unix milliseconds}). It is a control event, never written to a browser:
	 * the viewer said goodbye (or was removed), and behind the CDN their stream would
	 * otherwise stay open on whichever instance holds it until it reaches its full lifetime.
	 * Streams opened after "before" are a reload or another tab, and are left alone. */
	KindBye = "bye"
)

// ByeData is the payload of a KindBye event.
type ByeData struct {
	Before int64 `json:"before"`
}

/* Event is one thing to tell a webinar's viewers.
 *
 * To narrows delivery to those identities; empty means everyone subscribed to the webinar.
 * That is the same contract as LiveKit's SendData destination list, which is the point: the
 * server already decides recipients that way for the stage, and edge viewers inherit exactly
 * the same decisions. A packet addressed to the stage alone (panelist chat) names stage
 * identities, so no edge viewer — who is never on the stage while watching HLS — gets it. */
type Event struct {
	Slug string          `json:"s"`
	Kind string          `json:"k"`
	To   []string        `json:"t,omitempty"`
	Data json.RawMessage `json:"d,omitempty"`
}

// For reports whether identity should receive e.
func (e Event) For(identity string) bool {
	if len(e.To) == 0 {
		return true
	}
	for _, id := range e.To {
		if id == identity {
			return true
		}
	}
	return false
}

// SubscriberBuffer is how many undelivered events one viewer may have queued before they are
// dropped. A viewer who falls this far behind reconnects and refetches the backlogs.
const SubscriberBuffer = 64

// Sub is one open event stream.
type Sub struct {
	Slug     string
	Identity string
	// Since is when the stream subscribed.
	Since time.Time
	// C delivers events. Closed when the subscriber is dropped or cancelled.
	C chan Event

	once sync.Once
}

func (s *Sub) close() { s.once.Do(func() { close(s.C) }) }

/* Hub is the process-local subscriber registry.
 *
 * The zero value is not usable; call NewHub. Safe for concurrent use. */
type Hub struct {
	mu   sync.Mutex
	subs map[string]map[*Sub]struct{}
	// onFirst runs (outside the lock) when the first subscriber of the process arrives, so
	// the LISTEN connection is only opened by an instance that actually has a viewer.
	onFirst   func()
	firstOnce sync.Once
}

// NewHub returns an empty hub. onFirst may be nil.
func NewHub(onFirst func()) *Hub {
	return &Hub{subs: map[string]map[*Sub]struct{}{}, onFirst: onFirst}
}

// Subscribe registers a viewer and returns the subscription and its cancel. Calling cancel
// more than once is safe.
func (h *Hub) Subscribe(slug, identity string) (*Sub, func()) {
	sub := &Sub{Slug: slug, Identity: identity, Since: time.Now(), C: make(chan Event, SubscriberBuffer)}
	h.mu.Lock()
	set := h.subs[slug]
	if set == nil {
		set = map[*Sub]struct{}{}
		h.subs[slug] = set
	}
	set[sub] = struct{}{}
	h.mu.Unlock()
	if h.onFirst != nil {
		h.firstOnce.Do(h.onFirst)
	}
	return sub, func() { h.remove(sub) }
}

func (h *Hub) remove(sub *Sub) {
	h.mu.Lock()
	if set := h.subs[sub.Slug]; set != nil {
		delete(set, sub)
		if len(set) == 0 {
			delete(h.subs, sub.Slug)
		}
	}
	h.mu.Unlock()
	sub.close()
}

/* Dispatch delivers e to this process's matching subscribers.
 *
 * Never blocks: a subscriber whose buffer is full is dropped (its channel closed), and the
 * stream handler ends that response so the browser reconnects and catches up from the HTTP
 * backlogs. One stalled connection must not delay a chat message for everyone else. */
func (h *Hub) Dispatch(e Event) (delivered int) {
	if e.Kind == KindBye {
		return h.bye(e)
	}
	h.mu.Lock()
	var full []*Sub
	for sub := range h.subs[e.Slug] {
		if !e.For(sub.Identity) {
			continue
		}
		select {
		case sub.C <- e:
			delivered++
		default:
			full = append(full, sub)
		}
	}
	h.mu.Unlock()
	for _, sub := range full {
		h.remove(sub)
	}
	return delivered
}

/* bye closes the subscriptions a KindBye names: each identity in To (never everyone — a bye
 * with no recipients is ignored) whose stream opened before the cutoff. Returns how many. */
func (h *Hub) bye(e Event) int {
	var d ByeData
	if len(e.To) == 0 || json.Unmarshal(e.Data, &d) != nil || d.Before <= 0 {
		return 0
	}
	h.mu.Lock()
	var gone []*Sub
	for sub := range h.subs[e.Slug] {
		if e.For(sub.Identity) && sub.Since.UnixMilli() <= d.Before {
			gone = append(gone, sub)
		}
	}
	h.mu.Unlock()
	for _, sub := range gone {
		h.remove(sub)
	}
	return len(gone)
}

// Bye is the KindBye event that ends identity's streams on slug opened at or before before.
func Bye(slug, identity string, before time.Time) Event {
	data, _ := json.Marshal(ByeData{Before: before.UnixMilli()})
	return Event{Slug: slug, Kind: KindBye, To: []string{identity}, Data: data}
}

// Count is how many subscribers this process holds for a webinar.
func (h *Hub) Count(slug string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs[slug])
}

// Total is how many subscribers this process holds across every webinar: the edge viewers
// connected to this instance (the webinarliv.edge_viewers gauge).
func (h *Hub) Total() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, set := range h.subs {
		n += len(set)
	}
	return n
}

// Active reports whether this process has any subscriber at all.
func (h *Hub) Active() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs) > 0
}
