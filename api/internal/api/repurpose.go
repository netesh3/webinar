package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Content repurposing, in the host's AI insights tab: an ended session's transcript turned
 * into drafts for elsewhere (blog, newsletter, whitepaper, LinkedIn, X, Instagram), in the
 * host's brand voice. Behind the per-host switch "repurpose", which needs "ai".
 *
 *   ask       POST …/repurpose {formats} queues one draft per format (store.QueueRepurpose).
 *             Regenerate is the same request for a format that already has a draft: the old
 *             one stays readable until the new one replaces it, and the host's edits go.
 *   write     inside requests, never in the background: Cloud Run gives CPU only while a
 *             request is in flight, and the card polls GET while anything is queued. Each
 *             request claims what is due and writes it within repurposeInlineBudget, under the
 *             60 s server write timeout. Formats are written side by side, one gpt-5-nano call
 *             each, through aiComplete (feature "repurpose"), so the monthly caps hold and
 *             every call is counted. A request cut short leaves its claim to lapse; the next
 *             poll tries again, up to repurposeMaxAttempts.
 *   source    recapInput: the after-session transcript, else the live captions, with whatever
 *             was said while AI was paused already left out, plus the Q&A. A transcript too
 *             long to read whole is summarised into notes once per session end (session_ai_
 *             outputs "repurpose_notes", claimAndWrite) and every format is written from those.
 *   review    the host edits (PUT …/repurpose/{format}) and marks it reviewed; the card offers
 *             copy and download only after that. Nothing here publishes anything.
 *
 * Under requireOwnership (host and co-hosts, as the rest of AI insights). The brand voice is
 * the session host's, whoever presses Generate.
 */

const (
	// repurposeInlineBudget bounds the writing one request does, inside the 60 s WriteTimeout.
	repurposeInlineBudget = 50 * time.Second
	// repurposeClaimFor outlives one request's writing, so two polls never write one draft.
	repurposeClaimFor = 70 * time.Second
	// repurposeMaxAttempts is how often a draft is tried before it is settled failed.
	repurposeMaxAttempts = 3
	// repurposeMinCallTime is the least time worth starting a format's call with.
	repurposeMinCallTime = 25 * time.Second
	// repurposeMaxFormatsPerRequest bounds the calls one request makes side by side.
	repurposeMaxFormatsPerRequest = 6
)

// repurposeRetryAfter is how long a draft that failed waits before the next try. A var so
// tests can make it zero.
var repurposeRetryAfter = 20 * time.Second

// repurposeFormats is every format, in the card's order.
var repurposeFormats = []string{
	types.RepurposeBlog, types.RepurposeNewsletter, types.RepurposeWhitepaper,
	types.RepurposeLinkedIn, types.RepurposeXThread, types.RepurposeInstagram,
}

// repurposeNotesBody is the cached notes on a long transcript, one text per part.
type repurposeNotesBody struct {
	Notes []string `json:"notes"`
}

// repurposeSession is one session's material, read once per request.
type repurposeSession struct {
	in     aiwrite.RepurposeInput
	source string
}

/* repurposeMaterial reads what the drafts are written from: recapInput's transcript (or live
 * captions) and Q&A, the session's own copy, and the host's brand voice. No speech means
 * nothing to repurpose (in.Lines empty). */
func (s *Server) repurposeMaterial(ctx context.Context, wb types.Webinar) (repurposeSession, error) {
	rin, source, _, err := s.recapInput(ctx, wb, nil)
	if err != nil {
		return repurposeSession{}, err
	}
	in := aiwrite.RepurposeInput{
		Topic: wb.Topic, Description: wb.Summary, HostName: wb.Host.Name,
		Meeting: wb.Kind == types.KindMeeting, DurationSec: rin.DurationSec,
		Lines: rin.Lines, Questions: rin.Questions, Takeaways: wb.Takeaways,
	}
	for _, a := range wb.Agenda {
		in.Agenda = append(in.Agenda, strings.TrimSpace(a.Title+" "+a.Detail))
	}
	if v, err := s.store.BrandVoice(ctx, wb.Host.ID); err == nil {
		in.Voice = aiwrite.RepurposeVoice{Tone: v.Tone, Audience: v.Audience, DoWords: v.DoWords, DontWords: v.DontWords, Sample: v.Sample}
	} else if !errors.Is(err, store.ErrNotFound) {
		return repurposeSession{}, err
	}
	if len(in.Lines) == 0 {
		source = ""
	} else if aiwrite.NeedsRepurposeNotes(in.Lines) {
		source = "notes"
	}
	return repurposeSession{in: in, source: source}, nil
}

// repurposeGate is why drafts cannot be written now, "" when they can.
func (s *Server) repurposeGate(ctx context.Context, wb types.Webinar, m repurposeSession) string {
	if g := s.aiOutputGate(ctx, wb); g != "" {
		return g
	}
	if len(m.in.Lines) == 0 {
		return types.RepurposeReasonNoTranscript
	}
	return ""
}

/* writeRepurposeNotes is the notes on a long transcript: a call per part, side by side, each
 * through aiComplete. Any part failing fails the notes, so a draft is never written from half
 * a session. */
func (s *Server) writeRepurposeNotes(ctx context.Context, hostID string, in aiwrite.RepurposeInput) (any, string, error) {
	chunks := aiwrite.RepurposeChunks(in.Lines)
	notes := make([]string, len(chunks))
	errs := make([]error, len(chunks))
	model := ""
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i, c := range chunks {
		wg.Add(1)
		go func(i int, c []aiwrite.RecapLine) {
			defer wg.Done()
			reply, err := s.aiComplete(ctx, types.AIFeatureRepurpose, hostID, ai.Request{
				Messages:        aiwrite.RepurposeNotesMessages(in, c, i+1, len(chunks)),
				Schema:          aiwrite.RepurposeNotesSchema,
				MaxTokens:       aiwrite.RepurposeNotesMaxTokens,
				ReasoningEffort: "low",
				AttemptTimeout:  40 * time.Second,
			})
			if err == nil {
				notes[i], err = aiwrite.NotesText(reply.Text)
				mu.Lock()
				model = reply.Model
				mu.Unlock()
			}
			errs[i] = err
		}(i, c)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, "", err
		}
	}
	return repurposeNotesBody{Notes: notes}, model, nil
}

/* repurposeNow writes what is queued for this session, inside the current request. Reports
 * nothing: the caller reads the drafts back. Every write outlives the caller's own deadline
 * (WithoutCancel): a draft the model has answered is saved even when the host has left. */
func (s *Server) repurposeNow(parent context.Context, wb types.Webinar, m repurposeSession) {
	if s.repurposeGate(parent, wb, m) != "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), repurposeInlineBudget)
	defer cancel()
	bg := context.WithoutCancel(parent)
	slug := wb.ID
	formats, err := s.store.ClaimRepurpose(ctx, slug, repurposeMaxFormatsPerRequest, repurposeMaxAttempts, repurposeClaimFor)
	if err != nil {
		s.log.Warn("repurpose: claim", "slug", slug, "error", err)
		return
	}
	if len(formats) == 0 {
		return
	}
	in := m.in
	if aiwrite.NeedsRepurposeNotes(in.Lines) {
		row, status, err := s.claimAndWrite(ctx, slug, store.AIOutputRepurposeNotes, func(ctx context.Context) (any, string, error) {
			return s.writeRepurposeNotes(ctx, wb.Host.ID, in)
		})
		switch {
		case err != nil:
			s.log.Warn("repurpose: notes", "slug", slug, "error", err)
			s.settleRepurpose(bg, slug, formats, types.RecapReasonFailed, false)
			return
		case status == aiStatusLimit:
			s.settleRepurpose(bg, slug, formats, types.RecapReasonAILimit, true)
			return
		case status == aiStatusUnavailable || status == aiStatusFailed:
			s.settleRepurpose(bg, slug, formats, status, false)
			return
		case status != types.AIStatusReady:
			// Another request is writing the notes: hand these back for the next poll.
			_ = s.store.ReleaseRepurpose(bg, slug, formats)
			return
		}
		var body repurposeNotesBody
		if err := json.Unmarshal(row.Body, &body); err != nil || len(body.Notes) == 0 {
			s.settleRepurpose(bg, slug, formats, types.RecapReasonFailed, false)
			return
		}
		in.Notes, in.Lines = body.Notes, nil
	}
	deadline, _ := ctx.Deadline()
	left := time.Until(deadline)
	if left < repurposeMinCallTime {
		_ = s.store.ReleaseRepurpose(bg, slug, formats)
		return
	}
	var wg sync.WaitGroup
	for _, f := range formats {
		wg.Add(1)
		go func(f string) {
			defer wg.Done()
			s.writeRepurposeDraft(ctx, bg, wb, in, f, left-2*time.Second)
		}(f)
	}
	wg.Wait()
}

// writeRepurposeDraft is one format's call, and its outcome stored.
func (s *Server) writeRepurposeDraft(ctx, bg context.Context, wb types.Webinar, in aiwrite.RepurposeInput, format string, attempt time.Duration) {
	in.Format = format
	reply, err := s.aiComplete(ctx, types.AIFeatureRepurpose, wb.Host.ID, ai.Request{
		Messages:       aiwrite.RepurposeMessages(in),
		Schema:         aiwrite.RepurposeSchema,
		MaxTokens:      aiwrite.RepurposeMaxTokens(format),
		AttemptTimeout: attempt,
	})
	var text string
	if err == nil {
		text, err = aiwrite.ParseRepurpose(reply.Text, format)
	}
	switch {
	case errors.Is(err, errAILimit):
		s.settleRepurpose(bg, wb.ID, []string{format}, types.RecapReasonAILimit, true)
	case errors.Is(err, ai.ErrUnavailable):
		s.settleRepurpose(bg, wb.ID, []string{format}, types.RecapReasonAIUnavailable, false)
	case err != nil:
		s.log.Warn("repurpose: write", "slug", wb.ID, "format", format, "error", err)
		s.settleRepurpose(bg, wb.ID, []string{format}, types.RecapReasonFailed, false)
	default:
		if err := s.store.SaveRepurpose(bg, wb.ID, format, text, reply.Model); err != nil {
			s.log.Error("repurpose: save", "slug", wb.ID, "format", format, "error", err)
			return
		}
		s.log.Info("repurpose draft written", "slug", wb.ID, "format", format, "model", reply.Model,
			"notes", len(in.Notes) > 0, "runes", utf8.RuneCountInString(text))
	}
}

// settleRepurpose records a failure for formats: final, or back in the queue for a retry.
func (s *Server) settleRepurpose(ctx context.Context, slug string, formats []string, reason string, final bool) {
	for _, f := range formats {
		if err := s.store.FailRepurpose(ctx, slug, f, reason, final, repurposeRetryAfter); err != nil {
			s.log.Warn("repurpose: settle", "slug", slug, "format", f, "error", err)
		}
	}
}

// repurposeResponse is the card's state: why not (or ready), and every draft asked for.
func (s *Server) repurposeResponse(ctx context.Context, wb types.Webinar, m repurposeSession) (types.RepurposeResponse, error) {
	out := types.RepurposeResponse{Drafts: []types.RepurposeDraft{}, Source: m.source}
	out.Status = s.repurposeGate(ctx, wb, m)
	if out.Status == "" {
		out.Status = types.AIStatusReady
	}
	rows, err := s.store.RepurposeDrafts(ctx, wb.ID)
	if err != nil {
		return out, err
	}
	byFormat := make(map[string]store.RepurposeRow, len(rows))
	for _, r := range rows {
		byFormat[r.Format] = r
	}
	for _, f := range repurposeFormats {
		r, ok := byFormat[f]
		if !ok {
			continue
		}
		d := types.RepurposeDraft{Format: f, Markdown: r.Body, Reviewed: r.Reviewed}
		if r.Edited != nil {
			d.Markdown, d.Edited = *r.Edited, true
		}
		switch {
		case r.Status == store.AIOutputReady:
			d.Status = types.RepurposeReady
		case r.Status == store.AIOutputFailed:
			d.Status, d.Reason = types.RepurposeFailed, r.Reason
		case r.Claimed && r.Reason == "":
			d.Status = types.RepurposeWriting
		default:
			d.Status = types.RepurposeQueued
		}
		if r.GeneratedAt != nil {
			d.GeneratedAt = r.GeneratedAt.UTC().Format(time.RFC3339)
		}
		out.Drafts = append(out.Drafts, d)
	}
	if v, err := s.store.BrandVoice(ctx, wb.Host.ID); err == nil {
		out.BrandVoiceSet = !aiwrite.RepurposeVoice{Tone: v.Tone, Audience: v.Audience, DoWords: v.DoWords, DontWords: v.DontWords, Sample: v.Sample}.Empty()
	}
	return out, nil
}

// repurposeWebinar loads the session and checks its host's switch; false after answering.
func (s *Server) repurposeWebinar(w http.ResponseWriter, r *http.Request) (types.Webinar, bool) {
	ctx := r.Context()
	wb, err := s.store.WebinarBySlug(ctx, slugFromContext(ctx))
	if err != nil {
		s.fail(w, r, "repurpose: webinar", err)
		return wb, false
	}
	if !s.requireHostFeature(w, r, wb.Host.ID, types.FeatureRepurpose) {
		return wb, false
	}
	return wb, true
}

func (s *Server) writeRepurposeResponse(w http.ResponseWriter, r *http.Request, status int, wb types.Webinar, m repurposeSession) {
	out, err := s.repurposeResponse(r.Context(), wb, m)
	if err != nil {
		s.fail(w, r, "repurpose: read", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, status, out)
}

// handleGetRepurpose is GET /api/host/webinars/{slug}/repurpose: the drafts, and anything
// queued written inside this poll.
func (s *Server) handleGetRepurpose(w http.ResponseWriter, r *http.Request) {
	wb, ok := s.repurposeWebinar(w, r)
	if !ok {
		return
	}
	m, err := s.repurposeMaterial(r.Context(), wb)
	if err != nil {
		s.fail(w, r, "repurpose: material", err)
		return
	}
	s.repurposeNow(r.Context(), wb, m)
	s.writeRepurposeResponse(w, r, http.StatusOK, wb, m)
}

// repurposeRefusals is the plain sentence for each reason a request to write is refused.
var repurposeRefusals = map[string]string{
	aiStatusNotEnded:                  "Drafts can be written once the session has ended.",
	aiStatusOff:                       "AI isn't switched on for this account.",
	aiStatusSessionOff:                "AI was off for this session, so nothing from it can go to the AI.",
	aiStatusUnavailable:               "AI isn't available right now. Try again in a minute.",
	types.RepurposeReasonNoTranscript: "Nothing anyone said in this session was kept, so there is nothing to write from. Keep the room's AI switch on next time.",
}

/* handlePostRepurpose is POST /api/host/webinars/{slug}/repurpose: write (or rewrite) these
 * formats. Queued, then written inside this request as far as its budget goes; the card polls
 * for the rest. */
func (s *Server) handlePostRepurpose(w http.ResponseWriter, r *http.Request) {
	var req types.RepurposeRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Send the formats as JSON.")
		return
	}
	var formats []string
	for _, f := range req.Formats {
		if !aiwrite.ValidRepurposeFormat(f) {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_format", "That isn't one of the formats.")
			return
		}
		if !slices.Contains(formats, f) {
			formats = append(formats, f)
		}
	}
	if len(formats) == 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "no_formats", "Pick at least one format.")
		return
	}
	wb, ok := s.repurposeWebinar(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	m, err := s.repurposeMaterial(ctx, wb)
	if err != nil {
		s.fail(w, r, "repurpose: material", err)
		return
	}
	if g := s.repurposeGate(ctx, wb, m); g != "" {
		httpx.Error(w, http.StatusConflict, g, repurposeRefusals[g])
		return
	}
	// The cap is asked before anything is queued, so a host over it is told at once.
	if err := s.aiCapCheck(ctx, types.AIFeatureRepurpose, wb.Host.ID); errors.Is(err, errAILimit) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
		return
	} else if err != nil {
		s.fail(w, r, "repurpose: cap", err)
		return
	}
	if err := s.store.QueueRepurpose(ctx, wb.ID, formats); err != nil {
		s.fail(w, r, "repurpose: queue", err)
		return
	}
	s.log.Info("repurpose: drafts asked for", "slug", wb.ID, "formats", formats, "source", m.source)
	s.repurposeNow(ctx, wb, m)
	s.writeRepurposeResponse(w, r, http.StatusOK, wb, m)
}

// handlePutRepurpose is PUT /api/host/webinars/{slug}/repurpose/{format}: the host's edit and
// review mark.
func (s *Server) handlePutRepurpose(w http.ResponseWriter, r *http.Request) {
	format := chi.URLParam(r, "format")
	if !aiwrite.ValidRepurposeFormat(format) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such format.")
		return
	}
	var req types.RepurposeEditRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Send the draft as JSON.")
		return
	}
	text := strings.TrimSpace(strings.ReplaceAll(req.Markdown, "\r\n", "\n"))
	if text == "" {
		httpx.Error(w, http.StatusUnprocessableEntity, "empty", "The draft is empty. Regenerate it instead.")
		return
	}
	if utf8.RuneCountInString(text) > aiwrite.RepurposeMaxRunes(format)*2 {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_long", "That draft is too long to save.")
		return
	}
	wb, ok := s.repurposeWebinar(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	err := s.store.EditRepurpose(ctx, wb.ID, format, text, req.Reviewed)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusConflict, "no_draft", "There is no draft to edit yet.")
		return
	}
	if err != nil {
		s.fail(w, r, "repurpose: edit", err)
		return
	}
	m, err := s.repurposeMaterial(ctx, wb)
	if err != nil {
		s.fail(w, r, "repurpose: material", err)
		return
	}
	s.writeRepurposeResponse(w, r, http.StatusOK, wb, m)
}

// ---------------------------------------------------------------- brand voice

func brandVoiceOut(v store.BrandVoiceRow) types.BrandVoice {
	out := types.BrandVoice{Tone: v.Tone, Audience: v.Audience, DoWords: v.DoWords, DontWords: v.DontWords, Sample: v.Sample}
	if !v.UpdatedAt.IsZero() {
		out.UpdatedAt = v.UpdatedAt.UTC().Format(time.RFC3339)
	}
	return out
}

// handleGetBrandVoice is GET /api/host/brand-voice: the caller's own.
func (s *Server) handleGetBrandVoice(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureRepurpose) {
		return
	}
	v, err := s.store.BrandVoice(r.Context(), user.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "brand voice: read", err)
		return
	}
	httpx.JSON(w, http.StatusOK, brandVoiceOut(v))
}

// handlePutBrandVoice is PUT /api/host/brand-voice: replaces the caller's own.
func (s *Server) handlePutBrandVoice(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureRepurpose) {
		return
	}
	var req types.BrandVoice
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Send the brand voice as JSON.")
		return
	}
	v := store.BrandVoiceRow{
		Tone:      strings.TrimSpace(req.Tone),
		Audience:  strings.TrimSpace(req.Audience),
		DoWords:   strings.TrimSpace(req.DoWords),
		DontWords: strings.TrimSpace(req.DontWords),
		Sample:    strings.TrimSpace(strings.ReplaceAll(req.Sample, "\r\n", "\n")),
	}
	if utf8.RuneCountInString(v.Tone) > aiwrite.MaxVoiceToneRunes ||
		utf8.RuneCountInString(v.Audience) > aiwrite.MaxVoiceToneRunes ||
		utf8.RuneCountInString(v.DoWords) > aiwrite.MaxVoiceListRunes ||
		utf8.RuneCountInString(v.DontWords) > aiwrite.MaxVoiceListRunes ||
		utf8.RuneCountInString(v.Sample) > aiwrite.MaxVoiceSampleRunes {
		httpx.Error(w, http.StatusUnprocessableEntity, "too_long",
			"That's too long: keep tone and audience under 300 characters, the word lists under 500 and the sample under 3,000.")
		return
	}
	if err := s.store.SaveBrandVoice(r.Context(), user.ID, v); err != nil {
		s.fail(w, r, "brand voice: save", err)
		return
	}
	saved, err := s.store.BrandVoice(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "brand voice: read back", err)
		return
	}
	httpx.JSON(w, http.StatusOK, brandVoiceOut(saved))
}
