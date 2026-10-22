package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Server-side live captions.
 *
 * The browser engine (web/lib/local-captions.ts) runs Whisper tiny.en in each speaker's own
 * tab: English only, and it costs the speaker's laptop. The server engine is a LiveKit agent
 * on the egress host (deploy/captions) running multilingual faster-whisper over the ACTIVE
 * speakers only. It never runs inside the API; the API only:
 *
 *   - dispatches it to a room when the host turns server captions on, and removes the
 *     dispatch when they are turned off or the session ends (handleHostServerCaptions);
 *   - takes each finished line from it (handleInternalCaption), stores it exactly where a
 *     browser caption goes and fans it out as the same "caption" room packet, from the
 *     speaker's own Sender, so the existing overlay renders it unchanged. The packet goes
 *     through sendRoomPacket, whose edge tap (edgeRoom) also puts it on the realtime bus, so
 *     LL-HLS viewers get it over SSE like WebRTC participants get it from the SFU;
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
// the edge tap that wraps every one of them.
func dispatcherFor(rm RoomManager) (agentDispatcher, bool) {
	if er, ok := rm.(edgeRoom); ok {
		rm = er.RoomManager
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
	dispatcher, ok := dispatcherFor(sfu)
	if req.On && (!s.serverCaptionsConfigured() || !ok) {
		// The browser falls back to on-device captions on this answer.
		httpx.Error(w, http.StatusServiceUnavailable, "server_captions_unavailable",
			"Server captions aren't set up here. Captions will run on each speaker's device.")
		return
	}

	room := lk.RoomName(slug)
	if req.On {
		if wb.Status != types.StatusLive {
			httpx.Error(w, http.StatusConflict, "not_live", "Server captions start once the session is live.")
			return
		}
		if err := s.store.SetServerCaptions(r.Context(), slug, true); err != nil {
			s.fail(w, r, "server captions: save", err)
			return
		}
		meta, _ := json.Marshal(map[string]string{"slug": slug, "room": room})
		if _, err := dispatcher.DispatchAgent(r.Context(), room, s.captionAgentName(), string(meta)); err != nil {
			s.log.Warn("server captions: dispatch failed", "slug", slug, "error", err)
			_ = s.store.SetServerCaptions(r.Context(), slug, false)
			httpx.Error(w, http.StatusBadGateway, "dispatch_failed",
				"Couldn't start server captions. Captions will run on each speaker's device.")
			return
		}
		s.log.Info("server captions: dispatched", "slug", slug, "agent", s.captionAgentName())
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
	})
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
	// StartedAt is when the speech began, Unix milliseconds. Logged for latency only: the row
	// is stamped on arrival like a browser caption, so the two sources order the same way.
	StartedAt int64 `json:"startedAt"`
}

func (s *Server) handleInternalCaption(w http.ResponseWriter, r *http.Request) {
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
	/* Refused, not stored, once the host has switched off: the agent can be a few seconds
	 * behind the switch, and a line arriving after "off" must not appear on screen. 409 tells
	 * the agent to stop sending; it leaves when its dispatch is removed. */
	if !requested || !wb.Controls.CaptionsEnabled || wb.Status != types.StatusLive {
		httpx.Error(w, http.StatusConflict, "captions_off", "Server captions are off for this session.")
		return
	}
	sfu, err := s.sfuFor(r.Context(), wb)
	if err != nil {
		s.failSFU(w, r, wb, err)
		return
	}
	if err := s.store.AppendCaption(r.Context(), slug, identity, text); err != nil {
		s.fail(w, r, "internal caption: store", err)
		return
	}
	from := s.captionSpeaker(r.Context(), sfu, slug, identity)
	if err := s.sendRoomPacket(r.Context(), sfu, slug, nil, map[string]any{
		"kind": "caption",
		"from": from,
		"text": text,
	}); err != nil {
		// Stored already; the room missing one line is not worth failing the agent over.
		s.log.Warn("internal caption: fan-out failed", "slug", slug, "error", err)
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
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
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "ok", "serverCaptions": wb.Controls.ServerCaptions})
}

type internalTranscript struct {
	Room     string                    `json:"room"`
	Slug     string                    `json:"slug"`
	Model    string                    `json:"model"`
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
	err := s.store.SaveSessionTranscript(r.Context(), slug, model, segments)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "internal transcript: save", err)
		return
	}
	s.log.Info("session transcript stored", "slug", slug, "model", model, "segments", len(segments))
	// The AI recap was waiting for this: make it due, and write it now, in this request
	// (recapNow) — the tick only runs while somebody is using the site.
	if err := s.store.NudgeRecap(r.Context(), slug); err != nil {
		s.log.Warn("internal transcript: could not nudge the recap", "slug", slug, "error", err)
	} else {
		s.recapNow(r.Context(), slug)
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"status": "ok", "segments": len(segments)})
}
