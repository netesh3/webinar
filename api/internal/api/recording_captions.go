package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/captionvtt"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Captions on replays: a recording, and a simulive of it, show the ORIGINAL session's captions
 * as CC rather than transcribing the video again (internal/captionvtt).
 *
 * Source, best first: the after-session transcript (the large model's, session_transcripts),
 * else the live caption lines (session_captions). Times are placed on the recording's own
 * timeline by its takes' createdAt, the way the chapters are (web/lib/recap.ts). One file per
 * recording session, or per take with ?part=<take id> — the player swaps the <video>'s file at
 * each take, and a <track> follows the file it is on.
 *
 * Privacy. A transcript may exist that nobody was ever shown: the AI switch keeps one with
 * captions off (ai_session.go). That one is NOT put on a public replay or a simulive unless the
 * host turns on "Show captions on replays" (webinars.replay_captions); the default is on only
 * when captions were shown while the session was live (captions_shown_live, migration 0140).
 * The host's own Recording tab previews the captions whichever way the switch is set.
 *
 *   GET /api/webinars/{slug}/recordings/{id}/captions.vtt    public replay: its access rules
 *   GET /api/host/webinars/{slug}/recordings/{id}/captions.vtt  the stage (preview)
 *   GET /api/webinars/{slug}/captions.vtt                    a simulive's audience (joinKey)
 */

// captionMaxLines bounds the live caption lines read for one recording.
const captionMaxLines = 20_000

// captionTakes is the playlist the player plays: the ready takes, in order.
func captionTakes(parts []store.RecordingFile) []store.RecordingFile {
	return readyRecordingFiles(parts)
}

/* captionSpans lays out takes, or only the take with id part (offset 0: its own file). A take
 * of unknown length, the last one, is open-ended rather than empty. ok is false when part
 * names no playable take. */
func captionSpans(takes []store.RecordingFile, part string) ([]captionvtt.Span, bool) {
	in := make([]captionvtt.Take, len(takes))
	for i, t := range takes {
		d := time.Duration(t.DurationMs) * time.Millisecond
		if d <= 0 && i == len(takes)-1 {
			d = 24 * time.Hour
		}
		in[i] = captionvtt.Take{Start: t.CreatedAt, Duration: d}
	}
	spans := captionvtt.Spans(in)
	if part == "" {
		return spans, len(spans) > 0
	}
	for i, t := range takes {
		if t.ID == part {
			sp := spans[i]
			sp.Offset = 0
			return []captionvtt.Span{sp}, true
		}
	}
	return nil, false
}

// speakerLabelFor is how a caption names its speaker: the first name, or the role.
func speakerLabelFor(identity, name string, wb types.Webinar) string {
	isHost := wb.Host.ID != "" && identity == "user_"+wb.Host.ID
	if strings.TrimSpace(name) == "" && isHost {
		name = wb.Host.Name
	}
	if first := captionvtt.FirstName(name); first != "" {
		return first
	}
	switch {
	case isHost:
		return "Host"
	case strings.HasPrefix(identity, "att_"):
		return "Attendee"
	}
	return "Speaker"
}

/* captionLines is what was said during spans in wb (the original session): the transcript if
 * one covers it, else the live caption lines. */
func (s *Server) captionLines(ctx context.Context, wb types.Webinar, spans []captionvtt.Span) ([]captionvtt.Line, error) {
	from, to := spans[0].Start, spans[len(spans)-1].End
	segs, found, err := s.store.RecordingTranscript(ctx, wb.ID, from, to)
	if err != nil {
		return nil, err
	}
	if found {
		ids := map[string]bool{}
		var list []string
		for _, sg := range segs {
			if !ids[sg.Identity] {
				ids[sg.Identity] = true
				list = append(list, sg.Identity)
			}
		}
		names, err := s.store.SpeakerNames(ctx, list)
		if err != nil {
			return nil, err
		}
		out := make([]captionvtt.Line, 0, len(segs))
		for _, sg := range segs {
			name := names[sg.Identity]
			if strings.TrimSpace(name) == "" {
				name = sg.Name
			}
			out = append(out, captionvtt.Line{
				Start:   time.UnixMilli(sg.Start),
				End:     time.UnixMilli(sg.End),
				Speaker: speakerLabelFor(sg.Identity, name, wb),
				Text:    sg.Text,
			})
		}
		return out, nil
	}

	// A live line is stored when it is finished: its moment is its end.
	lines, err := s.store.RecordingCaptionLines(ctx, wb.ID, from, to.Add(6*time.Second), captionMaxLines)
	if err != nil {
		return nil, err
	}
	out := make([]captionvtt.Line, 0, len(lines))
	prev := map[string]time.Time{}
	for _, l := range lines {
		start := l.At.Add(-captionvtt.GuessDuration(l.Text))
		if p, ok := prev[l.Identity]; ok && start.Before(p) {
			start = p
		}
		prev[l.Identity] = l.At
		out = append(out, captionvtt.Line{
			Start:   start,
			End:     l.At,
			Speaker: speakerLabelFor(l.Identity, l.Name, wb),
			Text:    l.Text,
		})
	}
	return out, nil
}

// replayCaptionsShown is whether wb's captions may be shown on its replays and simulives.
func (s *Server) replayCaptionsShown(ctx context.Context, slug string) (bool, error) {
	setting, shownLive, err := s.store.ReplayCaptionsPolicy(ctx, slug)
	if err != nil {
		return false, err
	}
	return store.ShowReplayCaptions(setting, shownLive), nil
}

/* serveCaptions writes the VTT for takes of wb, or 404 when there is nothing to show. The
 * caller has decided the caller may watch the recording, and whether the switch applies. */
func (s *Server) serveCaptions(w http.ResponseWriter, r *http.Request, wb types.Webinar, takes []store.RecordingFile, part, cacheControl string) {
	spans, ok := captionSpans(captionTakes(takes), part)
	if !ok {
		httpx.Error(w, http.StatusNotFound, "no_captions", "This recording has no captions.")
		return
	}
	lines, err := s.captionLines(r.Context(), wb, spans)
	if err != nil {
		s.fail(w, r, "captions: lines", err)
		return
	}
	cues := captionvtt.Build(lines, spans)
	if len(cues) == 0 {
		httpx.Error(w, http.StatusNotFound, "no_captions", "This recording has no captions.")
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write([]byte(captionvtt.Render(cues)))
}

func (s *Server) noCaptions(w http.ResponseWriter) {
	httpx.Error(w, http.StatusNotFound, "no_captions", "This recording has no captions.")
}

// handlePublicRecordingCaptions is the public replay's CC: the same access as /public.
func (s *Server) handlePublicRecordingCaptions(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	id := chi.URLParam(r, "id")
	parts, err := s.store.SessionParts(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		s.noCaptions(w)
		return
	}
	if err != nil {
		s.fail(w, r, "public captions: parts", err)
		return
	}
	session := parts[0]
	for _, p := range parts {
		if p.ParentID == "" {
			session = p
			break
		}
	}
	if !session.IsPublic {
		s.noCaptions(w)
		return
	}
	pass := strings.TrimSpace(session.Passcode)
	if pass == "" {
		pass = strings.TrimSpace(session.WebinarPasscode)
	}
	cache := "public, max-age=300"
	if pass != "" {
		given := strings.TrimSpace(r.URL.Query().Get("passcode"))
		if given == "" {
			given = strings.TrimSpace(r.Header.Get("X-Passcode"))
		}
		if given != pass {
			httpx.Error(w, http.StatusUnauthorized, "passcode_required", "Passcode is incorrect or required.")
			return
		}
		cache = "private, max-age=300"
	}
	shown, err := s.replayCaptionsShown(r.Context(), session.Webinar)
	if err != nil {
		s.fail(w, r, "public captions: policy", err)
		return
	}
	if !shown {
		s.noCaptions(w)
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), session.Webinar)
	if err != nil {
		s.fail(w, r, "public captions: webinar", err)
		return
	}
	s.serveCaptions(w, r, wb, parts, r.URL.Query().Get("part"), cache)
}

// handleRecordingCaptions is the stage's preview: shown whichever way the switch is set.
func (s *Server) handleRecordingCaptions(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	parts, err := s.store.SessionParts(r.Context(), slug, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.noCaptions(w)
		return
	}
	if err != nil {
		s.fail(w, r, "captions: parts", err)
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), parts[0].Webinar)
	if err != nil {
		s.fail(w, r, "captions: webinar", err)
		return
	}
	s.serveCaptions(w, r, wb, parts, r.URL.Query().Get("part"), "private, no-cache")
}

/* handleSimuliveCaptions is a simulive's CC: its recording's original session's captions, on
 * the one file the simulive plays (simulivePlaybackURL). Same credential as the replay. */
func (s *Server) handleSimuliveCaptions(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	if _, ok := s.resolveSender(w, r, slug, r.URL.Query().Get("joinKey")); !ok {
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "simulive captions: webinar", err)
		return
	}
	f, orig, ok := s.simuliveCaptionSource(r.Context(), wb)
	if !ok {
		s.noCaptions(w)
		return
	}
	s.serveCaptions(w, r, orig, []store.RecordingFile{f}, "", "private, max-age=300")
}

/* simuliveCaptionSource is the file a simulive plays and the session it was recorded in, when
 * that session's captions may be shown on it. */
func (s *Server) simuliveCaptionSource(ctx context.Context, wb types.Webinar) (store.RecordingFile, types.Webinar, bool) {
	if wb.Kind != types.KindSimulive || wb.SimuliveRecordingID == "" {
		return store.RecordingFile{}, types.Webinar{}, false
	}
	f, err := s.store.RecordingFileByID(ctx, wb.SimuliveRecordingID)
	if err != nil {
		return store.RecordingFile{}, types.Webinar{}, false
	}
	if shown, err := s.replayCaptionsShown(ctx, f.Webinar); err != nil || !shown {
		return store.RecordingFile{}, types.Webinar{}, false
	}
	orig, err := s.store.WebinarBySlug(ctx, f.Webinar)
	if err != nil {
		return store.RecordingFile{}, types.Webinar{}, false
	}
	return f, orig, true
}

// simuliveHasCaptions is JoinResponse.SimuliveCaptions: worth offering CC at all.
func (s *Server) simuliveHasCaptions(ctx context.Context, wb types.Webinar) bool {
	_, orig, ok := s.simuliveCaptionSource(ctx, wb)
	if !ok {
		return false
	}
	has, err := s.store.HasCaptionSource(ctx, orig.ID)
	return err == nil && has
}

// stampRecordingCaptions fills Recording.CaptionsAvailable and ShowCaptions for slug's list.
func (s *Server) stampRecordingCaptions(ctx context.Context, slug string, list []types.Recording) {
	if len(list) == 0 {
		return
	}
	has, err := s.store.HasCaptionSource(ctx, slug)
	if err != nil {
		return
	}
	shown, err := s.replayCaptionsShown(ctx, slug)
	if err != nil {
		return
	}
	for i := range list {
		list[i].CaptionsAvailable = has
		list[i].ShowCaptions = shown
	}
}
