package api

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/internal/engagement/capture"
	"github.com/netkumar/webcast/api/internal/engagement/service"
	"github.com/netkumar/webcast/api/types"
)

/* engagementRetention is how long raw captured events are kept. The computed scores and
 * the summary document outlive them; see migrations/0059. */
const engagementRetention = 90 * 24 * time.Hour

func (s *Server) initEngagement() {
	s.capture = capture.New(s.store, capture.DefaultConfig(), s.log)
	s.engagement = service.New(s.store, s.capture, service.Config{}, s.log)
}

// CloseEngagement drains the capture buffer. Call after the HTTP server has shut down.
func (s *Server) CloseEngagement(ctx context.Context) error {
	err := s.capture.Close(ctx)
	st := s.capture.Stats()
	s.log.Info("engagement capture closed", "written", st.Written, "dropped", st.Dropped,
		"failed", st.Failed, "limited", st.Limited)
	return err
}

// EngagementCaptureStats is for diagnostics and tests.
func (s *Server) EngagementCaptureStats() capture.Stats { return s.capture.Stats() }

// FlushEngagement writes captured events now. For tests.
func (s *Server) FlushEngagement(ctx context.Context) error { return s.capture.Flush(ctx) }

/* recordRealtime keeps a copy of a relayed reaction or hand. Called after the packet is
 * on the wire; Record never blocks, so the relay's latency is unchanged. Only the
 * audience is captured — the stage is excluded from every figure the dashboard shows. */
func (s *Server) recordRealtime(slug string, from wireSender, packet wirePacket) {
	if !isAttendeeIdentity(from.Identity) {
		return
	}
	e := capture.Event{Slug: slug, Identity: from.Identity, At: time.UnixMilli(packet.At)}
	switch packet.Kind {
	case types.MsgReaction:
		e.Kind, e.Emoji = capture.Reaction, packet.Emoji
	case types.MsgHand:
		e.Kind = capture.HandLower
		if packet.Raised {
			e.Kind = capture.HandRaise
		}
	default:
		return
	}
	s.capture.Record(e)
}

func (s *Server) recordStage(slug, identity string, on bool) {
	if !isAttendeeIdentity(identity) {
		return
	}
	kind := capture.StageOff
	if on {
		kind = capture.StageOn
	}
	s.capture.Record(capture.Event{Slug: slug, Identity: identity, Kind: kind})
}

func isAttendeeIdentity(identity string) bool {
	return len(identity) > 4 && identity[:4] == "att_"
}

/* computeEngagementOnEnd materialises the final numbers once the room is gone and every
 * visit is closed, so the first host to open the page reads a stored snapshot. A failure
 * is logged and left for the lazy path to retry on the first request. */
func (s *Server) computeEngagementOnEnd(ctx context.Context, slug string) {
	w, err := s.store.EngagementWebinar(ctx, slug)
	if err != nil {
		s.log.Warn("end webinar: could not load webinar for engagement", "slug", slug, "error", err)
		return
	}
	if _, err := s.engagement.Compute(ctx, w); err != nil {
		s.log.Warn("end webinar: could not compute engagement", "slug", slug, "error", err)
	}
}

func (s *Server) sweepEngagementEvents(ctx context.Context) {
	n, err := s.store.PruneEngagementEvents(ctx, time.Now().Add(-engagementRetention), 5000)
	if err != nil {
		s.log.Error("engagement retention: prune failed", "error", err)
		return
	}
	if n > 0 {
		s.log.Info("engagement retention: pruned raw events", "rows", n)
	}
}
