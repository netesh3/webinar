package api

import (
	"context"
	"encoding/json"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* The room's AI switch (types.SessionControls.AIEnabled).
 *
 * Shown to the host and co-hosts of an account with the ai feature, on by default. It decides
 * three things about one session:
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
 *   pause     off DURING the live session pauses AI until the host turns it back on. Each
 *             pause is a window (store.AIOffWindows, migration 0143) and everything said,
 *             asked or chatted inside one stays out of every AI input: the transcript reads
 *             (store.TranscriptSince, RecapCaptions), the Q&A assistant and auto-answer reads
 *             (QAQuestions, QAPending, ClaimAutoQuestions), the harvest (HarvestQuestions), the
 *             hot-lead reasons' words (LeadRows) and the recap's questions and chat
 *             (AIOffItems). The hot-lead RANKING still counts everything: it is arithmetic,
 *             not a model. The caption agent leaves on a pause (with captions hidden) and is
 *             dispatched again on resume.
 */

// sessionAIAllowed reports whether this session may be processed by AI now: the host's account
// has the ai feature AND the session's own switch (controls.aiEnabled) is on, so not paused.
func (s *Server) sessionAIAllowed(ctx context.Context, wb types.Webinar) bool {
	return s.sessionAIBlock(ctx, wb) == ""
}

/* sessionAIBlock is why sessionAIAllowed says no, so a screen can say the right thing:
 * ai_off when the host's ACCOUNT does not have the ai feature (an admin decides),
 * ai_session_off when the account has it but this session's own switch is off — paused while
 * live, or off at the end (the host decided), "" when AI may be used. The account is asked
 * first: a session's switch on an account without AI is not the reason. */
func (s *Server) sessionAIBlock(ctx context.Context, wb types.Webinar) string {
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil || !host.HasFeature(types.FeatureAI) {
		return types.RecapReasonAIOff
	}
	/* AIEnabled as read is already false on an account without AI (store: AIEnabled &&
	 * AIAvailable), so it is only the session's own switch here. AIOffThisSession (paused
	 * right now) goes with AIEnabled off; read as well so the two can never disagree. */
	if !wb.Controls.AIEnabled || wb.Controls.AIOffThisSession {
		return types.RecapReasonAISessionOff
	}
	return ""
}

/* syncCaptionAgent brings the caption agent in line with the session's two switches, for a
 * live session. Either one wants it in the room:
 *
 *   captions shown  controls.captionsEnabled, and the host has server captions
 *                   (types.FeatureCaptions). Server captions are their own feature: they do
 *                   not use the paid AI, so a session with AI off still gets them. Dispatched
 *                   for the captions (SetServerCaptions).
 *   AI on           sessionAIAllowed: dispatched transcript only, captions left as they are
 *                   (RequestCaptionAgent). The agent shows its lines only while captions are.
 *
 * With neither, the agent is removed. Where it cannot run (no CAPTIONS_SECRET, a project with
 * no agent dispatch (the on-demand box without the captions box), the feature off, or the
 * dispatch failing) the speakers' browsers caption on-device instead (web/lib/ai-session.ts
 * captionEngine), and the reason is logged here so an operator can tell which source a room
 * ran on. Idempotent: an agent already asked for is left
 * alone, so the host's join can call it to retry a dispatch that failed.
 * Reports whether the stored state changed, so the caller re-reads before pushing metadata. */
func (s *Server) syncCaptionAgent(ctx context.Context, wb types.Webinar, sfu RoomManager) bool {
	// A simulive has no speakers: its captions are the original session's, never the agent's.
	if wb.Status != types.StatusLive || sfu == nil || wb.Kind == types.KindSimulive {
		return false
	}
	slug := wb.ID
	transcript := s.sessionAIAllowed(ctx, wb)
	display := wb.Controls.CaptionsEnabled && s.hostHas(ctx, wb.Host.ID, types.FeatureCaptions)
	if !display && !transcript {
		if wb.Controls.CaptionsEnabled {
			s.log.Info("server captions unavailable, captions run on-device",
				"slug", slug, "reason", "feature_off")
		}
		return s.turnOffServerCaptions(ctx, slug, sfu)
	}
	if !s.serverCaptionsConfigured() {
		if display {
			s.log.Info("server captions unavailable, captions run on-device",
				"slug", slug, "reason", "not_configured")
		}
		return false
	}
	d, ok := dispatcherFor(sfu)
	if !ok {
		if display {
			s.log.Warn("server captions unavailable, captions run on-device",
				"slug", slug, "reason", "no_agent_dispatch", "sfu_project", wb.SFUProject)
		}
		return false
	}
	already, err := s.store.ServerCaptionsRequested(ctx, slug)
	if err != nil {
		s.log.Warn("caption agent: could not read the request", "slug", slug, "error", err)
		return false
	}
	if already {
		return false
	}
	mode := "captions"
	if display {
		err = s.store.SetServerCaptions(ctx, slug, true)
	} else {
		mode = "transcript"
		err = s.store.RequestCaptionAgent(ctx, slug)
	}
	if err != nil {
		s.log.Warn("caption agent: could not record the request", "slug", slug, "mode", mode, "error", err)
		return false
	}
	room := lk.RoomName(slug)
	md := map[string]string{"slug": slug, "room": room}
	if !display {
		md["mode"] = "transcript"
	}
	meta, _ := json.Marshal(md)
	if _, err := d.DispatchAgent(ctx, room, s.captionAgentName(), string(meta)); err != nil {
		// The browsers caption instead: they do whenever the agent is not live.
		s.log.Warn("server captions unavailable, captions run on-device",
			"slug", slug, "reason", "dispatch_failed", "mode", mode,
			"agent", s.captionAgentName(), "error", err)
		_ = s.store.SetServerCaptions(ctx, slug, false)
		return true
	}
	s.log.Info("caption agent dispatched", "slug", slug, "mode", mode, "agent", s.captionAgentName())
	return true
}

// hostHas reports whether the account behind hostID has the feature key. False when the
// account cannot be read: the room then falls back to what needs no feature.
func (s *Server) hostHas(ctx context.Context, hostID, key string) bool {
	if hostID == "" {
		return false
	}
	host, err := s.store.UserByID(ctx, hostID)
	if err != nil {
		s.log.Warn("feature check: could not load the host", "host", hostID, "feature", key, "error", err)
		return false
	}
	return host.HasFeature(key)
}

// aiPausedMin is how long AI was paused during the session behind slug, for the Results
// notes; 0 when it never was or the windows cannot be read.
func (s *Server) aiPausedMin(ctx context.Context, slug string) int {
	ws, err := s.store.AIOffWindows(ctx, slug)
	if err != nil {
		return 0
	}
	return ws.Minutes(time.Now())
}
