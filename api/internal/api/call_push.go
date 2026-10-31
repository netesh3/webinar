package api

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* A call's push fan-out (31 Oct 2026, calls.go): the ring and its end through the push outbox,
 * to the callee's browsers (Web Push) and app installs (FCM), like every other notification
 * (push.go). Both are PushIncomingCall, so the one Settings toggle turns both off.
 *
 *   - Web Push: urgency high, TTL the rest of the ring, tag "call-<id>". The payload's data is
 *     the event (types.PushPayload.Data), which the service worker reads to show Accept and
 *     Decline, and later to close the ring when the call_ended arrives with the same tag.
 *   - FCM: DataOnly, a high-priority data message with no notification block, so the app
 *     draws its own ringing screen. Data is the same event, as strings.
 */

// callPushData is an event as FCM data: every value a string, null as "".
func callPushData(ev any) map[string]string {
	raw, _ := json.Marshal(ev)
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	out := make(map[string]string, len(fields))
	for k, v := range fields {
		switch t := v.(type) {
		case nil:
			out[k] = ""
		case string:
			out[k] = t
		default:
			out[k] = fmt.Sprint(t)
		}
	}
	return out
}

func callTag(id string) string { return "call-" + id }

// pushIncomingCall queues the ring for the callee's browsers and app installs.
func (s *Server) pushIncomingCall(ctx context.Context, c store.Call, ev types.IncomingCallEvent) {
	if !s.pushAny() {
		return
	}
	body := ev.Topic
	if body == "" {
		body = "Tap to answer."
	}
	ttl := time.Until(c.ExpiresAt)
	if ttl < time.Second {
		return
	}
	s.queueCallPush(ctx, c.CalleeID, store.PushMessage{
		Kind: types.PushIncomingCall, Title: clip(ev.CallerName, 60) + " is calling",
		Body: body, URL: ev.JoinURL, Tag: callTag(c.ID),
		Urgency: "high", TTL: ttl, DedupeKey: "call:" + c.ID,
		Data: callPushData(ev), DataOnly: true,
	})
}

/* pushCallEnded tells the callee's browsers and installs the ring is over. An unanswered call
 * (missed, or the caller hung up) leaves a "Missed call" in its place; one answered or declined
 * on another device carries no title, and the service worker and the app clear the ring
 * without showing anything new. */
func (s *Server) pushCallEnded(ctx context.Context, c store.Call) {
	if !s.pushAny() {
		return
	}
	m := store.PushMessage{
		Kind: types.PushIncomingCall, URL: "/", Tag: callTag(c.ID),
		Urgency: "high", TTL: 2 * time.Minute, DedupeKey: "call-end:" + c.ID,
		Data: callPushData(callEndedEvent(c)), DataOnly: true,
	}
	if c.State == types.CallMissed || c.State == types.CallCancelled {
		m.Title = "Missed call from " + clip(c.CallerName, 60)
		m.Body = clip(c.Topic, 120)
		m.TTL = time.Hour
	}
	s.queueCallPush(ctx, c.CalleeID, m)
}

func (s *Server) queueCallPush(ctx context.Context, userID string, m store.PushMessage) {
	n, err := s.store.QueuePushToUsers(ctx, []string{userID}, s.channels(m))
	if err != nil {
		s.log.Error("push: queue call", "error", err)
		return
	}
	if n > 0 {
		s.flushPushSoon()
	}
}
