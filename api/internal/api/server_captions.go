package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/realtime"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Server-side live captions.
 *
 * The browser engine (web/lib/local-captions.ts) runs Whisper tiny.en in each speaker's own
 * tab: English only, and it costs the speaker's laptop. The server engine is a LiveKit agent
 * (deploy/captions) running English-only faster-whisper over the ACTIVE speakers only; for the
 * on-demand video box it runs on the separate captions box (captions_box.go), never on the box. It never runs inside the API; the API only:
 *
 *   - dispatches it to a room when the host turns server captions on, and removes the
 *     dispatch when they are turned off or the session ends (handleHostServerCaptions);
 *   - takes each finished line from it (handleInternalCaption), stores it exactly where a
 *     browser caption goes and fans it out as the same "caption" room packet, from the
 *     speaker's own Sender, so the existing overlay renders it unchanged. The packet goes
 *     through sendRoomPacket, whose edge tap (edgeRoom) also puts it on the realtime bus, so
 *     LL-HLS viewers get it over SSE like WebRTC participants get it from the SFU. A current
 *     agent publishes the packet to the room itself first (it sits beside the SFU, and this
 *     relay was most of a line's delay after decoding) and says so (published): then only
 *     the edge copy goes from here. Interim (partial) lines come here only for an edge room,
 *     go only to its audience, and are never stored;
 *   - records the agent's own report of whether it is live (handleInternalCaptionStatus),
 *     which is what SessionControls.ServerCaptions — the browsers' "skip local Whisper" —
 *     follows;
 *   - stores the after-session transcript the agent produces with a bigger model once the
 *     room has ended (handleInternalTranscript).
 *
 * The three internal endpoints are authenticated by CAPTIONS_SECRET, compared in constant
 * time, and are not mounted at all without it. */

// agentDispatcher is the slice of lk.Client the caption agent needs. Separate from
// RoomManager so the many fakes of that interface do not all have to grow two methods.
type agentDispatcher interface {
	DispatchAgent(ctx context.Context, room, agentName, metadata string) (string, error)
	StopAgent(ctx context.Context, room, agentName string) error
}

var _ agentDispatcher = (*lk.Client)(nil)

// dispatcherFor finds the agent dispatcher behind a resolved room manager, looking through
// the edge tap that wraps every one of them, and keeping the on-demand box's guard. A box room
// has none without a worker for it, on the video box (captionsOnVideoBox) or the captions box
// (captionsOn): nothing would ever take the dispatch, so the room captions on-device and the
// host is told server captions are unavailable.
func dispatcherFor(rm RoomManager) (agentDispatcher, bool) {
	if er, ok := rm.(edgeRoom); ok {
		rm = er.RoomManager
	}
	if br, ok := rm.(boxRoom); ok {
		if !br.s.captionsOnVideoBox() && !br.s.captionsOn() {
			return nil, false
		}
		d, ok := unwrapRoom(br).(agentDispatcher)
		if !ok {
			return nil, false
		}
		return boxDispatcher{agentDispatcher: d, r: br}, true
	}
	d, ok := rm.(agentDispatcher)
	return d, ok
}

func (s *Server) serverCaptionsConfigured() bool { return s.cfg.CaptionsSecret != "" }

func (s *Server) captionAgentName() string {
	if n := strings.TrimSpace(s.cfg.CaptionsAgentName); n != "" {
		return n
	}
	return "webinar-captions"
}

// handleHostServerCaptions is POST /api/host/webinars/{slug}/captions/server {on}.
func (s *Server) handleHostServerCaptions(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	var req types.ServerCaptionsRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "server captions: load webinar", err)
		return
	}
	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	/* A simulive plays a recording: there is nobody speaking to caption, and its CC is the
	 * original session's captions (recording_captions.go). The agent is never sent in. */
	if req.On && wb.Kind == types.KindSimulive {
		httpx.Error(w, http.StatusConflict, "simulive_captions",
			"A simulive shows its recording's own captions. There's nothing live to caption.")
		return
	}
	/* The host's switch (types.FeatureCaptions): Business and Enterprise since 1 Nov 2026
	 * (migrations/0180). Without it the browser turns on captions made on each speaker's
	 * device instead (caption-overlay.tsx), and says why with this message. */
	if req.On && !s.hostHas(r.Context(), wb.Host.ID, types.FeatureCaptions) {
		httpx.Error(w, http.StatusForbidden, "feature_off",
			"Device captions on your plan. AI Live captions are on Business and up.")
		return
	}
	dispatcher, ok := dispatcherFor(sfu)
	if req.On && (!s.serverCaptionsConfigured() || !ok) {
		// The browser falls back to on-device captions on this answer.
		httpx.Error(w, http.StatusServiceUnavailable, "server_captions_unavailable",
			"AI Live captions aren't set up here. Captions will run on each speaker's device.")
		return
	}

	room := lk.RoomName(slug)
	if req.On {
		if wb.Status != types.StatusLive {
			httpx.Error(w, http.StatusConflict, "not_live", "AI Live captions start once the session is live.")
			return
		}
		if err := s.store.SetServerCaptions(r.Context(), slug, true); err != nil {
			s.fail(w, r, "server captions: save", err)
			return
		}
		meta := s.captionAgentMeta(r.Context(), slug, nil)
		if _, err := dispatcher.DispatchAgent(r.Context(), room, s.captionAgentName(), meta); err != nil {
			s.log.Warn("server captions: dispatch failed", "slug", slug, "error", err)
			_ = s.store.SetServerCaptions(r.Context(), slug, false)
			httpx.Error(w, http.StatusBadGateway, "dispatch_failed",
				"Couldn't start AI Live captions. Captions will run on each speaker's device.")
			return
		}
		s.log.Info("server captions: dispatched", "slug", slug, "agent", s.captionAgentName())
	} else if wb.Status == types.StatusLive && s.sessionAIAllowed(r.Context(), wb) {
		// The session's AI switch still wants the transcript: the agent stays, transcript only.
		s.log.Info("server captions: off requested, agent kept for the AI transcript", "slug", slug)
	} else {
		if err := s.store.SetServerCaptions(r.Context(), slug, false); err != nil {
			s.fail(w, r, "server captions: save", err)
			return
		}
		if ok {
			s.stopCaptionAgent(r.Context(), dispatcher, slug)
		}
	}

	wb, err = s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "server captions: reload webinar", err)
		return
	}
	s.pushRoomMetadata(r, sfu, wb)
	httpx.JSON(w, http.StatusOK, wb)
}

func (s *Server) stopCaptionAgent(ctx context.Context, d agentDispatcher, slug string) {
	if err := d.StopAgent(ctx, lk.RoomName(slug), s.captionAgentName()); err != nil {
		s.log.Warn("server captions: could not remove the dispatch", "slug", slug, "error", err)
	}
}

/* turnOffServerCaptions is "the session no longer wants the agent": captions switched off
 * through /controls, or the session ending. Reports whether anything was on. */
func (s *Server) turnOffServerCaptions(ctx context.Context, slug string, sfu RoomManager) bool {
	on, err := s.store.ServerCaptionsRequested(ctx, slug)
	if err != nil || !on {
		return false
	}
	if err := s.store.SetServerCaptions(ctx, slug, false); err != nil {
		s.log.Warn("server captions: could not clear", "slug", slug, "error", err)
	}
	if sfu != nil {
		if d, ok := dispatcherFor(sfu); ok {
			s.stopCaptionAgent(ctx, d, slug)
		}
	}
	return true
}

// ------------------------------------------------------------- internal endpoints

// requireCaptionsSecret guards the agent's endpoints.
func (s *Server) requireCaptionsSecret(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Captions-Secret")
		if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.CaptionsSecret)) != 1 {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Bad captions secret.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) mountCaptionsInternal(r chi.Router) {
	if !s.serverCaptionsConfigured() {
		return
	}
	r.Group(func(r chi.Router) {
		r.Use(s.requireCaptionsSecret)
		r.Post("/internal/captions", s.handleInternalCaption)
		r.Post("/internal/captions/status", s.handleInternalCaptionStatus)
		r.Post("/internal/transcripts", s.handleInternalTranscript)
		r.Post("/internal/transcripts/wanted", s.handleInternalTranscriptWanted)
	})
}

/* captionAgentMeta is the metadata a caption agent's dispatch carries (the agent reads it
 * from its job): the slug and room, plus "final":"skip" for a webinar an admin marked as a
 * load test (admin_loadtest.go). The after-session pass runs the big model over the whole
 * session's audio, and a load test's transcript is never read: on 2026-10-26 one such pass
 * held a 2-vCPU captions box at 91% for twenty minutes, then got a 404 because the kit had
 * already deleted the webinar; and "language", the session's captions language. A failed
 * lookup leaves the pass on (a real session must never
 * lose its transcript to a database blip). RedispatchIdle copies the metadata as it is. */
func (s *Server) captionAgentMeta(ctx context.Context, slug string, extra map[string]string) string {
	md := map[string]string{"slug": slug, "room": lk.RoomName(slug)}
	for k, v := range extra {
		md[k] = v
	}
	if _, ok, err := s.store.LoadTestViewers(ctx, slug); err == nil && ok {
		md["final"] = "skip"
	}
	/* The captions language the agent starts in (a Deepgram code, types.CaptionLanguages).
	 * A change in the room arrives as room metadata (controls.captionsLanguage), which the
	 * agent prefers once it has joined. A failed lookup sends the server default. */
	if lang, err := s.store.CaptionsLanguageOf(ctx, slug); err == nil {
		md["language"] = lang
	} else {
		md["language"] = s.defaultCaptionsLanguage()
	}
	meta, _ := json.Marshal(md)
	return string(meta)
}

/* handleInternalTranscriptWanted answers the captions worker before it starts (or resumes)
 * an after-session pass: is a transcript for this room still wanted? 200 {"wanted":true};
 * 200 {"wanted":false,"reason":"load_test"} for a load test; 404 {"gone":true} when the
 * webinar no longer exists. The worker deletes the room's audio only on the last two, and
 * only when the body says so (an API without this route answers a plain 404, which must not
 * read as "gone"). The pass itself is minutes of the big model; this is one indexed query. */
func (s *Server) handleInternalTranscriptWanted(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Room string `json:"room"`
		Slug string `json:"slug"`
	}
	if err := decodeAgentJSON(w, r, 1<<14, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	slug := agentSlug(req.Room, req.Slug)
	if slug == "" {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "room is required.")
		return
	}
	if _, err := s.store.WebinarBySlug(r.Context(), slug); errors.Is(err, store.ErrNotFound) {
		httpx.JSON(w, http.StatusNotFound, map[string]any{"wanted": false, "gone": true})
		return
	} else if err != nil {
		s.fail(w, r, "internal transcript wanted: webinar", err)
		return
	}
	if _, ok, err := s.store.LoadTestViewers(r.Context(), slug); err == nil && ok {
		httpx.JSON(w, http.StatusOK, map[string]any{"wanted": false, "reason": "load_test"})
		return
	}
	/* The after-session pass is the paid provider again (1 Nov 2026): not for a host whose
	 * plan has no server captions, whatever was asked for during the session. */
	if wb, err := s.store.WebinarBySlug(r.Context(), slug); err == nil && !s.hostHas(r.Context(), wb.Host.ID, types.FeatureCaptions) {
		httpx.JSON(w, http.StatusOK, map[string]any{"wanted": false, "reason": "plan"})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"wanted": true})
}

/* decodeAgentJSON reads an agent body. Unknown fields are allowed, unlike the browser
 * endpoints: the agent ships on its own schedule, and a newer one adding a field must not
 * lose every caption to a 400 against an older API. */
func decodeAgentJSON(w http.ResponseWriter, r *http.Request, limit int64, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	return json.NewDecoder(r.Body).Decode(dst)
}

// agentSlug resolves the webinar a request names, by LiveKit room or by slug.
func agentSlug(room, slug string) string {
	if s := lk.SlugFromRoom(strings.TrimSpace(room)); s != "" {
		return s
	}
	return strings.TrimSpace(slug)
}

type internalCaption struct {
	Room     string `json:"room"`
	Slug     string `json:"slug"`
	Identity string `json:"identity"`
	Text     string `json:"text"`
	// StartedAt / EndedAt bound the speech the line covers, Unix milliseconds (the agent's
	// clock). For latency, and for the edge audience's sync (lagMs below): the row is stamped
	// on arrival like a browser caption, so the two sources order the same way.
	StartedAt int64 `json:"startedAt"`
	EndedAt   int64 `json:"endedAt"`
	// Published: the agent has already put this line on the room itself (it sits beside the
	// SFU), so it is stored and copied to the edge audience but not sent to the SFU again.
	Published bool `json:"published"`
	// Partial is interim text for a line still being spoken: display-only, for the edge
	// audience (the room has it from the agent). Never stored, never kept for the AI.
	Partial bool `json:"partial"`
}

/* captionPacket is the "caption" room packet (web/lib/realtime.ts decodes it). id ties a
 * line's partials to its final, which replaces them; lagMs is how old the end of the speech
 * is as the packet leaves, which an edge viewer — whose video is seconds behind — uses to
 * hold the line until the video gets there. Both are omitted for an agent too old to send
 * the times, which leaves the packet exactly what it was. */
func captionPacket(from wireSender, req internalCaption, text string, now time.Time) map[string]any {
	pkt := map[string]any{"kind": "caption", "from": from, "text": text}
	if req.EndedAt > 0 && req.StartedAt > 0 {
		pkt["id"] = from.Identity + ":" + strconv.FormatInt(req.StartedAt, 10)
		pkt["startedAt"] = req.StartedAt
		pkt["endedAt"] = req.EndedAt
		pkt["lagMs"] = max(0, now.UnixMilli()-req.EndedAt)
	}
	if req.Partial {
		pkt["partial"] = true
	}
	return pkt
}

func (s *Server) handleInternalCaption(w http.ResponseWriter, r *http.Request) {
	began := time.Now()
	var req internalCaption
	if err := decodeAgentJSON(w, r, 64<<10, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	slug := agentSlug(req.Room, req.Slug)
	identity := clamp(req.Identity, 200)
	text := clamp(req.Text, 280)
	if slug == "" || identity == "" {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "room and identity are required.")
		return
	}
	if text == "" {
		httpx.Error(w, http.StatusBadRequest, "empty", "There's nothing to caption.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "internal caption: load webinar", err)
		return
	}
	requested, err := s.store.ServerCaptionsRequested(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "internal caption: state", err)
		return
	}
	/* Two switches decide (ai_session.go): captions shown (captionsEnabled) fans the line out
	 * to the room; the session's AI switch (aiEnabled) keeps it for the AI. With neither, it
	 * is refused, not stored: the agent can be a few seconds behind the switch, and a line
	 * arriving after "off" must not appear on screen or be kept. 409 tells the agent to stop
	 * sending; it leaves when its dispatch is removed. */
	display := wb.Controls.CaptionsEnabled
	keep := display || wb.Controls.AIEnabled
	if !requested || !keep || wb.Status != types.StatusLive {
		httpx.Error(w, http.StatusConflict, "captions_off", "AI Live captions are off for this session.")
		return
	}
	if req.Partial && !display {
		httpx.Error(w, http.StatusConflict, "captions_hidden", "Captions aren't shown in this session.")
		return
	}
	edge := s.isEdge(r.Context(), slug)
	// The agent posts partials only for an edge room (it learns which from this answer).
	ok := map[string]any{"status": "ok", "edge": edge}
	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	if req.Partial {
		if edge {
			s.publishCaptionEdge(r.Context(), slug, captionPacket(s.captionSpeaker(r.Context(), sfu, slug, identity), req, text, time.Now()))
		}
		httpx.JSON(w, http.StatusOK, ok)
		return
	}
	if err := s.store.AppendCaption(r.Context(), slug, identity, text); err != nil {
		s.fail(w, r, "internal caption: store", err)
		return
	}
	if !display {
		// Transcript only: kept for the AI recap, shown to nobody.
		httpx.JSON(w, http.StatusOK, ok)
		return
	}
	pkt := captionPacket(s.captionSpeaker(r.Context(), sfu, slug, identity), req, text, time.Now())
	if req.Published {
		// The room has it already, from the agent; only the edge audience still needs it.
		s.publishCaptionEdge(r.Context(), slug, pkt)
	} else if err := s.sendRoomPacket(r.Context(), sfu, slug, nil, pkt); err != nil {
		// Stored already; the room missing one line is not worth failing the agent over.
		s.log.Warn("internal caption: fan-out failed", "slug", slug, "error", err)
	}
	/* Latency, per line: age_ms is speech start -> relayed, end_age_ms speech end -> relayed
	 * (the agent's decode, its POST and this handler), handler_ms this handler alone. The
	 * agent logs its own side once a minute ("caption latency"). */
	attrs := []any{"slug", slug, "published", req.Published, "edge", edge,
		"handler_ms", time.Since(began).Milliseconds()}
	if req.StartedAt > 0 {
		attrs = append(attrs, "age_ms", time.Now().UnixMilli()-req.StartedAt)
	}
	if req.EndedAt > 0 {
		attrs = append(attrs, "end_age_ms", time.Now().UnixMilli()-req.EndedAt)
	}
	s.log.Info("internal caption: relayed", attrs...)
	httpx.JSON(w, http.StatusOK, ok)
}

// publishCaptionEdge copies a caption packet to the edge audience only (no SFU send).
func (s *Server) publishCaptionEdge(ctx context.Context, slug string, pkt map[string]any) {
	body, err := json.Marshal(pkt)
	if err != nil {
		return
	}
	s.publishEdge(ctx, slug, realtime.KindPacket, body, nil)
}

/* captionSpeaker is the Sender a caption is labelled with: the speaker's own name and role,
 * as the SFU lists them, so the line reads exactly like the one their browser would have
 * sent. Cached for a minute per speaker, because a talking panelist produces a line every
 * few seconds and the roster does not change that fast. */
func (s *Server) captionSpeaker(ctx context.Context, sfu RoomManager, slug, identity string) wireSender {
	key := slug + "\x00" + identity
	if v, ok := speakerCache.Load(key); ok {
		if e := v.(speakerEntry); time.Since(e.at) < speakerTTL {
			return e.sender
		}
	}
	sender := wireSender{Identity: identity, Name: "Speaker", Role: types.RolePanelist}
	if list, err := sfu.Participants(ctx, lk.RoomName(slug)); err == nil {
		for _, p := range list {
			if p.Identity == identity {
				if strings.TrimSpace(p.Name) != "" {
					sender.Name = p.Name
				}
				if p.Role != "" {
					sender.Role = p.Role
				}
				break
			}
		}
	} else {
		s.log.Warn("internal caption: roster lookup failed", "slug", slug, "error", err)
	}
	speakerCache.Store(key, speakerEntry{sender: sender, at: time.Now()})
	return sender
}

const speakerTTL = time.Minute

type speakerEntry struct {
	sender wireSender
	at     time.Time
}

var speakerCache sync.Map

type internalCaptionStatus struct {
	Room  string `json:"room"`
	Slug  string `json:"slug"`
	State string `json:"state"` // live | paused | stopped
}

// handleInternalCaptionStatus is the agent saying it is transcribing (live), or not
// (paused by its CPU guard, or stopped), so the browsers know whether to caption themselves.
func (s *Server) handleInternalCaptionStatus(w http.ResponseWriter, r *http.Request) {
	var req internalCaptionStatus
	if err := decodeAgentJSON(w, r, 16<<10, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	slug := agentSlug(req.Room, req.Slug)
	var live bool
	switch req.State {
	case "live":
		live = true
	case "paused", "stopped":
	default:
		httpx.Error(w, http.StatusBadRequest, "bad_state", "state must be live, paused or stopped.")
		return
	}
	if slug == "" {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "room is required.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "caption status: load webinar", err)
		return
	}
	changed, err := s.store.SetServerCaptionsLive(r.Context(), slug, live)
	if err != nil {
		s.fail(w, r, "caption status: save", err)
		return
	}
	if changed {
		s.log.Info("server captions: agent reported", "slug", slug, "state", req.State)
		if wb, err = s.store.WebinarBySlug(r.Context(), slug); err == nil {
			if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
				s.pushRoomMetadata(r, sfu, wb)
			}
		}
	}
	// edge: the agent sends interim captions to the API only for an edge room's audience.
	httpx.JSON(w, http.StatusOK, map[string]any{
		"status": "ok", "serverCaptions": wb.Controls.ServerCaptions, "edge": s.isEdge(r.Context(), slug),
	})
}

type internalTranscript struct {
	Room     string                    `json:"room"`
	Slug     string                    `json:"slug"`
	Model    string                    `json:"model"`
	Language string                    `json:"language"` // the captions language it streamed in; optional
	Segments []store.TranscriptSegment `json:"segments"`
}

// maxTranscriptSegments bounds one transcript: a four-hour session at one line every two
// seconds, with room to spare.
const maxTranscriptSegments = 20_000

func (s *Server) handleInternalTranscript(w http.ResponseWriter, r *http.Request) {
	var req internalTranscript
	if err := decodeAgentJSON(w, r, 16<<20, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	slug := agentSlug(req.Room, req.Slug)
	model := clamp(req.Model, 100)
	if slug == "" || model == "" {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "room and model are required.")
		return
	}
	if len(req.Segments) > maxTranscriptSegments {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "too_many_segments", "That transcript is too long.")
		return
	}
	segments := make([]store.TranscriptSegment, 0, len(req.Segments))
	for _, seg := range req.Segments {
		text := clamp(seg.Text, 4000)
		if text == "" {
			continue
		}
		segments = append(segments, store.TranscriptSegment{
			Identity: clamp(seg.Identity, 200),
			Name:     clamp(seg.Name, 200),
			Start:    seg.Start,
			End:      max(seg.End, seg.Start),
			Text:     text,
		})
	}
	// A language the list does not know (an older worker sends none) is the webinar's.
	language := strings.TrimSpace(req.Language)
	if !types.ValidCaptionLanguage(language) {
		language = ""
	}
	err := s.store.SaveSessionTranscriptIn(r.Context(), slug, model, language, segments)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "internal transcript: save", err)
		return
	}
	s.log.Info("session transcript stored", "slug", slug, "model", model, "language", language, "segments", len(segments))
	// The AI recap was waiting for this: make it due, and write it now, in this request
	// (recapNow) — the tick only runs while somebody is using the site.
	if err := s.store.NudgeRecap(r.Context(), slug); err != nil {
		s.log.Warn("internal transcript: could not nudge the recap", "slug", slug, "error", err)
	} else {
		s.recapNow(r.Context(), slug)
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"status": "ok", "segments": len(segments)})
}

// defaultCaptionsLanguage is CAPTIONS_DEFAULT_LANGUAGE, en-IN when unset (as in a test config).
func (s *Server) defaultCaptionsLanguage() string {
	return types.CaptionLanguageOrDefault(s.cfg.CaptionsDefaultLanguage, "")
}
