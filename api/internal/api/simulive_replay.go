package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/replay"
	"github.com/netkumar/webcast/api/types"
)

/* Simulive engagement replay (FeatureReplayEngage, internal/replay).
 *
 * The timeline is computed on the server and fetched once by each browser, which schedules it
 * against its own video's playback position — not pushed event by event. The playback clock
 * is per viewer (the player seeks a late joiner to the shared position, see
 * web/lib/simulive-replay.ts), so a server push could only ever be approximately in step with
 * any one viewer, while a timeline is exactly in step with all of them. It is the same for
 * every viewer, which makes it cacheable, and it changes only when the host curates it.
 *
 * Live chat and questions from the new audience go through /say as in any session and are
 * interleaved with the replayed items in the browser.
 *
 * AUTO MODE (not built): an assistant that answers the new audience's questions, signed
 * "✨ <Coach>'s assistant", would hang off the MsgQuestion case in say.go for a simulive with
 * FeatureReplayEngage (and FeatureAI) on — the same place qaAssistOn's clustering is
 * triggered — answering through UpdateSessionQuestion so the answer reaches the room the way
 * a host's does. The replay itself needs nothing from it.
 */

// replayAvailable reports whether this webinar plays an engagement replay at all.
func (s *Server) replayAvailable(ctx context.Context, wb types.Webinar) bool {
	return wb.Kind == types.KindSimulive && wb.SimuliveRecordingID != "" &&
		s.hostFeature(ctx, wb.Host.ID, types.FeatureReplayEngage)
}

// replayTimeline builds the timeline for wb. preview is the host's view (keys, hidden items).
func (s *Server) replayTimeline(ctx context.Context, wb types.Webinar, preview bool) (types.ReplayTimeline, error) {
	src, err := s.store.ReplaySource(ctx, wb.SimuliveRecordingID)
	if err != nil {
		return types.ReplayTimeline{}, err
	}
	hidden, err := s.store.ReplayHidden(ctx, wb.ID)
	if err != nil {
		return types.ReplayTimeline{}, err
	}
	return types.ReplayTimeline{
		Enabled:    true,
		DurationMs: src.Duration.Milliseconds(),
		Items:      replay.Build(src, hidden, preview),
	}, nil
}

/* handleReplayTimeline is the audience's timeline: GET /api/webinars/{slug}/replay.
 *
 * Same credential as the chat backlog (resolveSender): somebody in this session, by join key
 * or by session. Enabled false, rather than an error, for a session without the replay, so
 * the room can ask without knowing. Never the host preview's keys or hidden items, whoever
 * asks — the host's own room shows what the audience sees.
 */
func (s *Server) handleReplayTimeline(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if _, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey")); !ok {
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "replay: load webinar", err)
		return
	}
	// The same for everyone in the session and only changed by the host's curation, so a
	// browser may keep it a minute. Private: it is behind the session's credential.
	w.Header().Set("Cache-Control", "private, max-age=60")
	if !s.replayAvailable(r.Context(), wb) {
		httpx.JSON(w, http.StatusOK, types.ReplayTimeline{Items: []types.ReplayItem{}})
		return
	}
	tl, err := s.replayTimeline(r.Context(), wb, false)
	if err != nil {
		s.fail(w, r, "replay: timeline", err)
		return
	}
	httpx.JSON(w, http.StatusOK, tl)
}

// replayHostWebinar loads the webinar for the host's replay routes, answering for itself when
// the replay does not apply. requireOwnership has already decided the caller may act on it.
func (s *Server) replayHostWebinar(w http.ResponseWriter, r *http.Request) (types.Webinar, bool) {
	wb, err := s.store.WebinarBySlug(r.Context(), slugFromContext(r.Context()))
	if err != nil {
		s.fail(w, r, "replay: load webinar", err)
		return types.Webinar{}, false
	}
	if wb.Kind != types.KindSimulive || wb.SimuliveRecordingID == "" {
		httpx.Error(w, http.StatusConflict, "not_simulive",
			"Engagement replay is for a simulive session with a recording picked.")
		return types.Webinar{}, false
	}
	if !s.hostFeature(r.Context(), wb.Host.ID, types.FeatureReplayEngage) {
		httpx.Error(w, http.StatusForbidden, "feature_off",
			featureLabel(types.FeatureReplayEngage)+" isn't switched on for this account.")
		return types.Webinar{}, false
	}
	return wb, true
}

// handleHostReplayPreview is GET /api/host/webinars/{slug}/replay: every item, with its key
// and whether it is hidden, so the host can curate before (or during) the session.
func (s *Server) handleHostReplayPreview(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.replayHostWebinar(w, r)
	if !ok {
		return
	}
	tl, err := s.replayTimeline(r.Context(), wb, true)
	if err != nil {
		s.fail(w, r, "replay preview", err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, tl)
}

// handleSetReplayHidden is PUT /api/host/webinars/{slug}/replay/hidden.
func (s *Server) handleSetReplayHidden(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.replayHostWebinar(w, r)
	if !ok {
		return
	}
	var body types.ReplayHideRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	body.Key = strings.TrimSpace(body.Key)
	if !replay.ValidKey(body.Key) {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_key", "That isn't an item of this replay.")
		return
	}
	if err := s.store.SetReplayHidden(r.Context(), wb.ID, body.Key, body.Hidden); err != nil {
		s.fail(w, r, "replay: set hidden", err)
		return
	}
	tl, err := s.replayTimeline(r.Context(), wb, true)
	if err != nil {
		s.fail(w, r, "replay preview", err)
		return
	}
	httpx.JSON(w, http.StatusOK, tl)
}

/* refuseSimuliveRecording is the no-re-recording rule: a simulive plays a recording, and is
 * never recorded itself — not by Record, not by "Record automatically", not by any egress.
 * Regardless of FeatureReplayEngage. */
func refuseSimuliveRecording(w http.ResponseWriter, wb types.Webinar) bool {
	if wb.Kind != types.KindSimulive {
		return false
	}
	httpx.Error(w, http.StatusUnprocessableEntity, "simulive_not_recordable",
		"A simulive session plays a recording, so it can't be recorded again.")
	return true
}

// refuseInSimulive refuses to put anyone on a simulive's stage: the audience watches the
// recording, and nothing anybody publishes reaches them.
func refuseInSimulive(w http.ResponseWriter, wb types.Webinar) bool {
	if wb.Kind != types.KindSimulive {
		return false
	}
	httpx.Error(w, http.StatusUnprocessableEntity, "simulive_no_stage",
		"A simulive session plays its recording to everyone, so there is no stage to bring anyone onto.")
	return true
}
