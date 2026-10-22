package api

import (
	"context"
	"encoding/json"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* The room's AI switch (types.SessionControls.AIEnabled).
 *
 * Shown to the host and co-hosts of an account with the ai feature, on by default. It decides
 * two things about one session:
 *
 *   capture   while it is on and the session is live, a transcript is kept for the AI even
 *             when nobody is shown captions. Display and capture are separate switches:
 *             captionsEnabled is whether people SEE the lines, aiEnabled whether they are
 *             KEPT. Where the caption agent runs (deploy/captions) it is dispatched in a
 *             transcript-only mode: handleInternalCaption stores its lines always and fans
 *             them out to the room only while captions are shown. Where it does not, the
 *             speakers' browsers run their on-device engine silently (web/lib/ai-session.ts).
 *   use       off when the session ends, no recap is written (skipped, ai_session_off) and
 *             nothing of the session goes to a model.
 */

// sessionAIAllowed reports whether this session may be processed by AI: the host's account has
// the ai feature AND the session's own switch (controls.aiEnabled) is on.
func (s *Server) sessionAIAllowed(ctx context.Context, wb types.Webinar) bool {
	if !wb.Controls.AIEnabled {
		return false
	}
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	return err == nil && host.HasFeature(types.FeatureAI)
}

/* syncAITranscript brings the caption agent in line with the session's switches, for a live
 * session: dispatched (transcript only, captions left as they are) while AI is on; removed when
 * AI is off and captions are not shown either. With captions shown the agent stays, as it would
 * have without AI. Nothing to do where no agent is set up: the browsers capture instead.
 * Reports whether the stored state changed, so the caller re-reads before pushing metadata. */
func (s *Server) syncAITranscript(ctx context.Context, wb types.Webinar, sfu RoomManager) bool {
	if wb.Status != types.StatusLive || sfu == nil {
		return false
	}
	slug := wb.ID
	if !s.sessionAIAllowed(ctx, wb) {
		if wb.Controls.CaptionsEnabled {
			return false
		}
		return s.turnOffServerCaptions(ctx, slug, sfu)
	}
	if !s.serverCaptionsConfigured() {
		return false
	}
	d, ok := dispatcherFor(sfu)
	if !ok {
		return false
	}
	already, err := s.store.ServerCaptionsRequested(ctx, slug)
	if err != nil || already {
		return false
	}
	if err := s.store.RequestCaptionAgent(ctx, slug); err != nil {
		s.log.Warn("ai transcript: could not record the request", "slug", slug, "error", err)
		return false
	}
	room := lk.RoomName(slug)
	meta, _ := json.Marshal(map[string]string{"slug": slug, "room": room, "mode": "transcript"})
	if _, err := d.DispatchAgent(ctx, room, s.captionAgentName(), string(meta)); err != nil {
		// The browsers capture instead: they do whenever the agent is not live.
		s.log.Warn("ai transcript: dispatch failed", "slug", slug, "error", err)
		_ = s.store.SetServerCaptions(ctx, slug, false)
		return true
	}
	s.log.Info("ai transcript: caption agent dispatched", "slug", slug, "agent", s.captionAgentName())
	return true
}
