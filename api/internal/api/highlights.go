package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/highlights"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Suggested highlights on a session's recording (the "clips" switch, which needs "ai" and
 * "cloud_recording"): the moments worth cutting into short clips, under the player in the
 * Recording tab, each previewed by playing just that stretch.
 *
 *   count     the engagement (reactions, chat, questions, polls) and the transcript, both on
 *             the recording's own player timeline (its takes end to end, captionvtt.Spans),
 *             so a suggestion's times are the player's. What was said while AI was paused is
 *             left out of what the model reads; the counts keep it (they are arithmetic).
 *   pick      gpt-5-nano through aiComplete (feature "highlights"), one call for a session up
 *             to about two hours, a call per part side by side for a longer one, each told
 *             where the audience reacted most (highlights.Peaks).
 *   snap      every pick starts and ends on a sentence, lasts 20–90 s and lies inside one take
 *             (highlights.Snap), then the picks are ranked together on the model's interest and
 *             the counted engagement (highlights.Rank).
 *   cache     written once, lazily, on the first look after the session ends, inside that
 *             request (Cloud Run has CPU only during one), and kept per recording
 *             (recording_highlights). "Find them again" (POST) rewrites them.
 *
 * Under requireOwnership: the host and co-hosts, as the rest of the session's AI. The host's
 * switch decides, whoever looks.
 */

const (
	// highlightsWant is how many suggestions a recording gets at most.
	highlightsWant = 6
	// highlightsPerPart is how many each part of a long transcript is asked for.
	highlightsPerPart = 4
	// highlightsPeaks is how many engagement peaks the model is told about.
	highlightsPeaks = 12
	// highlightsClaimFor outlives one request's calls.
	highlightsClaimFor = 2 * time.Minute
	// highlightsBudget bounds the calls one request makes, inside the 60 s write timeout.
	highlightsBudget = 45 * time.Second
)

// highlightsRetryAfter is how long a failed pick waits before a look tries again. A var so
// tests can make it zero.
var highlightsRetryAfter = time.Minute

type highlightsBody struct {
	Highlights []types.Highlight `json:"highlights"`
}

// highlightMaterial is one recording's transcript and engagement, on its player timeline.
type highlightMaterial struct {
	sentences   []highlights.Sentence
	moments     []highlights.Moment
	parts       []highlights.Part
	durationSec float64
}

/* highlightsMaterial reads what the picks are made from: the caption lines of the recording's
 * takes (the after-session transcript, else the live captions) without what was said while AI
 * was paused, split into sentences; and the audience's engagement in the same window. */
func (s *Server) highlightsMaterial(ctx context.Context, wb types.Webinar, takes []store.RecordingFile) (highlightMaterial, error) {
	var m highlightMaterial
	spans, ok := captionSpans(takes, "")
	if !ok {
		return m, nil
	}
	lines, err := s.captionLines(ctx, wb, spans)
	if err != nil {
		return m, err
	}
	off, err := s.store.AIOffWindows(ctx, wb.ID)
	if err != nil {
		return m, err
	}
	placed := make([]highlights.Sentence, 0, len(lines))
	for _, l := range lines {
		if off.Contains(l.Start) {
			continue
		}
		start, ok := highlights.OnPlaylist(spans, l.Start)
		if !ok {
			continue
		}
		end := start
		if !l.End.IsZero() {
			if e, ok := highlights.OnPlaylist(spans, l.End); ok && e > start {
				end = e
			}
		}
		placed = append(placed, highlights.Sentence{StartSec: start, EndSec: end, Speaker: l.Speaker, Text: l.Text})
	}
	m.sentences = highlights.Sentences(placed)

	ids := make([]string, len(takes))
	for i, t := range takes {
		ids[i] = t.ID
	}
	m.parts = highlights.Parts(spans, ids)
	if n := len(m.parts); n > 0 {
		m.durationSec = m.parts[n-1].EndSec
	}
	last := spans[len(spans)-1].End
	if last.Sub(spans[0].Start) > 24*time.Hour {
		last = spans[0].Start.Add(24 * time.Hour) // the open-ended last take of captionSpans
	}
	events, err := s.store.HighlightEvents(ctx, wb.ID, spans[0].Start, last.Add(time.Duration(highlights.Lag)*time.Second))
	if err != nil {
		return m, err
	}
	m.moments = highlights.Moments(spans, events)
	return m, nil
}

// promptLines is the sentences as the model reads them, timed in whole seconds.
func promptLines(sentences []highlights.Sentence) []aiwrite.RecapLine {
	out := make([]aiwrite.RecapLine, 0, len(sentences))
	for _, x := range sentences {
		out = append(out, aiwrite.RecapLine{AtSec: int(x.StartSec), Speaker: x.Speaker, Text: x.Text})
	}
	return out
}

/* writeHighlights makes the calls (a part at a time, side by side, for a long transcript),
 * snaps every pick, and ranks them together. */
func (s *Server) writeHighlights(ctx context.Context, wb types.Webinar, m highlightMaterial) (highlightsBody, string, error) {
	lines := promptLines(m.sentences)
	chunks := aiwrite.HighlightChunks(lines)
	peaks := highlights.Peaks(m.moments, m.durationSec, highlightsPeaks)
	want := highlightsWant
	if len(chunks) > 1 {
		want = highlightsPerPart
	}
	results := make([][]aiwrite.HighlightMoment, len(chunks))
	errs := make([]error, len(chunks))
	model := ""
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i, c := range chunks {
		in := aiwrite.HighlightsInput{Topic: wb.Topic, HostName: wb.Host.Name, Lines: c, Want: want}
		if len(chunks) > 1 {
			in.Part, in.Parts = i+1, len(chunks)
		}
		lo, hi := float64(c[0].AtSec), float64(c[len(c)-1].AtSec)
		for _, p := range peaks {
			if p.StartSec >= lo && p.StartSec <= hi {
				in.Peaks = append(in.Peaks, aiwrite.HighlightPeak{
					StartSec: int(p.StartSec), EndSec: int(p.EndSec),
					Reactions: p.Signals.Reactions, Chat: p.Signals.Chat, Questions: p.Signals.Questions, Polls: p.Signals.Polls,
				})
			}
		}
		wg.Add(1)
		go func(i int, in aiwrite.HighlightsInput) {
			defer wg.Done()
			reply, err := s.aiComplete(ctx, types.AIFeatureHighlights, wb.Host.ID, ai.Request{
				Messages:        aiwrite.HighlightsMessages(in),
				Schema:          aiwrite.HighlightsSchema,
				MaxTokens:       aiwrite.HighlightsMaxTokens,
				ReasoningEffort: "low",
				AttemptTimeout:  40 * time.Second,
			})
			if err == nil {
				results[i], err = aiwrite.ParseHighlights(reply.Text, in.Lines, in.Want)
				mu.Lock()
				model = reply.Model
				mu.Unlock()
			}
			errs[i] = err
		}(i, in)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return highlightsBody{}, "", err
		}
	}
	var picks []highlights.Pick
	for _, r := range results {
		for _, mo := range r {
			start, end, part, ok := highlights.Snap(float64(mo.StartSec), float64(mo.EndSec), m.sentences, m.parts)
			if !ok {
				continue
			}
			picks = append(picks, highlights.Pick{StartSec: start, EndSec: end, Part: part, Title: mo.Title, Why: mo.Why, Interest: mo.Interest})
		}
	}
	ranked := highlights.Rank(picks, m.moments, m.sentences, highlightsWant)
	for i := range ranked {
		ranked[i].ID = "h" + strconv.Itoa(i+1)
	}
	return highlightsBody{Highlights: ranked}, model, nil
}

// highlightsResponse is the stored row as the card reads it.
func highlightsResponse(row store.HighlightsRow) types.HighlightsResponse {
	out := types.HighlightsResponse{Highlights: []types.Highlight{}}
	var body highlightsBody
	if len(row.Body) > 0 && json.Unmarshal(row.Body, &body) == nil && body.Highlights != nil {
		out.Highlights = body.Highlights
	}
	switch row.Status {
	case store.AIOutputReady:
		out.Status = types.AIStatusReady
	case store.AIOutputFailed:
		out.Status = row.Reason
		if out.Status == "" {
			out.Status = aiStatusFailed
		}
	default:
		out.Status = aiStatusProcessing
	}
	if row.GeneratedAt != nil {
		out.GeneratedAt = row.GeneratedAt.UTC().Format(time.RFC3339)
	}
	return out
}

// handleGetHighlights is GET /api/host/webinars/{slug}/recordings/{id}/highlights: the
// suggestions, written inside this request the first time.
func (s *Server) handleGetHighlights(w http.ResponseWriter, r *http.Request) {
	s.serveHighlights(w, r, false)
}

// handleFindHighlights is POST …/highlights: "Find them again", rewriting the suggestions.
func (s *Server) handleFindHighlights(w http.ResponseWriter, r *http.Request) {
	s.serveHighlights(w, r, true)
}

func (s *Server) serveHighlights(w http.ResponseWriter, r *http.Request, rewrite bool) {
	ctx := r.Context()
	slug := slugFromContext(ctx)
	parts, err := s.store.SessionParts(ctx, slug, chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such recording.")
		return
	}
	if err != nil {
		s.fail(w, r, "highlights: parts", err)
		return
	}
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		s.fail(w, r, "highlights: webinar", err)
		return
	}
	if !s.requireHostFeature(w, r, wb.Host.ID, types.FeatureClips) {
		return
	}
	sessionID := parts[0].ID
	for _, p := range parts {
		if p.ParentID == "" {
			sessionID = p.ID
			break
		}
	}
	reply := func(status int, out types.HighlightsResponse) {
		w.Header().Set("Cache-Control", "private, no-store")
		httpx.JSON(w, status, out)
	}
	refuse := func(reason string) {
		if rewrite {
			httpx.Error(w, http.StatusConflict, reason, highlightRefusals[reason])
			return
		}
		reply(http.StatusOK, types.HighlightsResponse{Status: reason, Highlights: []types.Highlight{}})
	}

	row, err := s.store.RecordingHighlights(ctx, sessionID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "highlights: read", err)
		return
	}
	found := err == nil
	if found && !rewrite && row.Status == store.AIOutputReady {
		reply(http.StatusOK, highlightsResponse(row))
		return
	}
	if gate := s.aiOutputGate(ctx, wb); gate != "" {
		refuse(gate)
		return
	}
	takes := captionTakes(parts)
	if len(takes) == 0 {
		refuse(types.HighlightsNotReady)
		return
	}
	m, err := s.highlightsMaterial(ctx, wb, takes)
	if err != nil {
		s.fail(w, r, "highlights: material", err)
		return
	}
	if len(m.sentences) == 0 {
		refuse(types.HighlightsNoTranscript)
		return
	}
	if rewrite {
		if err := s.aiCapCheck(ctx, types.AIFeatureHighlights, wb.Host.ID); errors.Is(err, errAILimit) {
			httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
			return
		} else if err != nil {
			s.fail(w, r, "highlights: cap", err)
			return
		}
	}
	claimed, err := s.store.ClaimRecordingHighlights(ctx, sessionID, rewrite, highlightsClaimFor)
	if err != nil {
		s.fail(w, r, "highlights: claim", err)
		return
	}
	if claimed {
		s.pickHighlights(ctx, wb, sessionID, m)
	}
	row, err = s.store.RecordingHighlights(ctx, sessionID)
	if err != nil {
		s.fail(w, r, "highlights: read back", err)
		return
	}
	reply(http.StatusOK, highlightsResponse(row))
}

// pickHighlights is the claimed write: the calls, and their outcome stored whatever the
// caller does meanwhile.
func (s *Server) pickHighlights(parent context.Context, wb types.Webinar, sessionID string, m highlightMaterial) {
	bg := context.WithoutCancel(parent)
	ctx, cancel := context.WithTimeout(bg, highlightsBudget)
	defer cancel()
	body, model, err := s.writeHighlights(ctx, wb, m)
	switch {
	case errors.Is(err, errAILimit):
		_ = s.store.FailRecordingHighlights(bg, sessionID, aiStatusLimit, 0)
	case errors.Is(err, ai.ErrUnavailable):
		_ = s.store.FailRecordingHighlights(bg, sessionID, aiStatusUnavailable, highlightsRetryAfter)
	case err != nil:
		s.log.Warn("highlights: write", "slug", wb.ID, "recording", sessionID, "error", err)
		_ = s.store.FailRecordingHighlights(bg, sessionID, aiStatusFailed, highlightsRetryAfter)
	default:
		if err := s.store.SaveRecordingHighlights(bg, sessionID, body, model); err != nil {
			s.log.Error("highlights: save", "slug", wb.ID, "recording", sessionID, "error", err)
			_ = s.store.FailRecordingHighlights(bg, sessionID, aiStatusFailed, highlightsRetryAfter)
			return
		}
		s.log.Info("highlights written", "slug", wb.ID, "recording", sessionID, "model", model,
			"highlights", len(body.Highlights), "sentences", len(m.sentences), "moments", len(m.moments))
	}
}

// highlightRefusals is the plain sentence for each reason "Find them again" is refused.
var highlightRefusals = map[string]string{
	aiStatusNotEnded:             "Highlights can be found once the session has ended.",
	aiStatusOff:                  "AI isn't switched on for this account.",
	aiStatusSessionOff:           "AI was off for this session, so nothing from it can go to the AI.",
	aiStatusUnavailable:          "AI isn't available right now. Try again in a minute.",
	types.HighlightsNotReady:     "This recording isn't ready to play yet.",
	types.HighlightsNoTranscript: "Nothing said in this recording was captioned, so there is nothing to pick moments from.",
}
