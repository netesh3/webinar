package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/clips"
	"github.com/netkumar/webcast/api/internal/highlights"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Suggested reels on a session's recording (the "clips" switch): 2-4 short moments on one
 * theme each, to stitch into a 30-60 second reel. Beside the highlights in the Recording tab,
 * and made the same way (highlights.go): the same transcript and engagement on the player
 * timeline, AI_MODEL_HIGHLIGHTS through aiComplete (feature "reels"), written only when the
 * host asks (POST: "Suggest reels", then "Suggest again", inside that request) and kept per
 * recording (recording_reels). GET never calls the AI: it reads what is kept, not_started, or
 * why there can be none. The reels are planned from the transcript and engagement directly,
 * not from the highlights, so either can be asked for first and neither waits on the other.
 * Every moment is snapped to sentences (4-25 s, inside one take) and
 * every reel kept to clips.Reel's rules. */

const (
	// reelsWant is how many reels a recording gets at most.
	reelsWant = 3
	// reelsMax bounds them over the parts of a long session (one asked of each part).
	reelsMax = 4
)

type reelsBody struct {
	Reels []types.Reel `json:"reels"`
}

// writeReels makes the calls (a part at a time, side by side, for a long transcript) and keeps
// what snaps into a reel.
func (s *Server) writeReels(ctx context.Context, wb types.Webinar, m highlightMaterial) (reelsBody, string, error) {
	lines := promptLines(m.sentences)
	chunks := aiwrite.HighlightChunks(lines)
	peaks := highlights.Peaks(m.moments, m.durationSec, highlightsPeaks)
	want := reelsWant
	if len(chunks) > 1 {
		want = 1
	}
	results := make([][]aiwrite.ReelPlan, len(chunks))
	errs := make([]error, len(chunks))
	model := ""
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i, c := range chunks {
		in := aiwrite.ReelsInput{Topic: wb.Topic, HostName: wb.Host.Name, Lines: c, Want: want}
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
		go func(i int, in aiwrite.ReelsInput) {
			defer wg.Done()
			reply, err := s.aiComplete(ctx, types.AIFeatureReels, wb.Host.ID, ai.Request{
				Messages:        aiwrite.ReelsMessages(in),
				Schema:          aiwrite.ReelsSchema,
				MaxTokens:       aiwrite.ReelsMaxTokens,
				ReasoningEffort: "low",
				AttemptTimeout:  40 * time.Second,
			})
			if err == nil {
				results[i], err = aiwrite.ParseReels(reply.Text, in.Lines, in.Want)
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
			return reelsBody{}, "", err
		}
	}
	out := reelsBody{Reels: []types.Reel{}}
	for _, plans := range results {
		for _, p := range plans {
			if r, ok := snapReel(p, m); ok {
				r.ID = "r" + strconv.Itoa(len(out.Reels)+1)
				out.Reels = append(out.Reels, r)
			}
			if len(out.Reels) == reelsMax {
				return out, model, nil
			}
		}
	}
	return out, model, nil
}

// snapReel turns a plan into a reel that can be cut: every moment on sentences, inside one
// take, then the reel's own rules. false when it does not survive them.
func snapReel(p aiwrite.ReelPlan, m highlightMaterial) (types.Reel, bool) {
	var moments []types.ReelMoment
	for _, mo := range p.Moments {
		start, end, part, ok := highlights.SnapWithin(float64(mo.StartSec), float64(mo.EndSec), m.sentences, m.parts,
			types.ReelMomentMinSec, types.ReelMomentMaxSec)
		if !ok {
			continue
		}
		rm := types.ReelMoment{StartSec: start, EndSec: end, PartID: part.ID}
		for _, x := range m.sentences {
			if x.EndSec > start {
				rm.Quote = x.Text
				break
			}
		}
		moments = append(moments, rm)
	}
	kept, total, ok := clips.Reel(moments)
	if !ok {
		return types.Reel{}, false
	}
	return types.Reel{Title: p.Title, Hook: p.Hook, Why: p.Why, Moments: kept, DurationSec: total}, true
}

func reelsResponse(row store.HighlightsRow) types.ReelsResponse {
	h := highlightsResponse(row) // the same statuses
	out := types.ReelsResponse{Status: h.Status, GeneratedAt: h.GeneratedAt, Reels: []types.Reel{}}
	var body reelsBody
	if len(row.Body) > 0 && json.Unmarshal(row.Body, &body) == nil && body.Reels != nil {
		out.Reels = body.Reels
	}
	return out
}

// handleGetReels is GET /api/host/webinars/{slug}/recordings/{id}/reels: never an AI call.
func (s *Server) handleGetReels(w http.ResponseWriter, r *http.Request) { s.serveReels(w, r, false) }

// handleFindReels is POST …/reels: the first plan ("Suggest reels") and every one after.
func (s *Server) handleFindReels(w http.ResponseWriter, r *http.Request) { s.serveReels(w, r, true) }

func (s *Server) serveReels(w http.ResponseWriter, r *http.Request, rewrite bool) {
	ctx := r.Context()
	rc, ok := s.clipRecording(w, r)
	if !ok {
		return
	}
	reply := func(out types.ReelsResponse) {
		w.Header().Set("Cache-Control", "private, no-store")
		httpx.JSON(w, http.StatusOK, out)
	}
	refuse := func(reason string) {
		if rewrite {
			httpx.Error(w, http.StatusConflict, reason, highlightRefusals[reason])
			return
		}
		reply(types.ReelsResponse{Status: reason, Reels: []types.Reel{}})
	}
	row, err := s.store.RecordingReels(ctx, rc.sessionID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "reels: read", err)
		return
	}
	found := err == nil
	if found && !rewrite && row.Status == store.AIOutputReady {
		reply(reelsResponse(row))
		return
	}
	if gate := s.aiOutputGate(ctx, rc.wb); gate != "" {
		refuse(gate)
		return
	}
	takes := captionTakes(rc.parts)
	if len(takes) == 0 {
		refuse(types.HighlightsNotReady)
		return
	}
	m, err := s.highlightsMaterial(ctx, rc.wb, takes)
	if err != nil {
		s.fail(w, r, "reels: material", err)
		return
	}
	if len(m.sentences) == 0 {
		refuse(types.HighlightsNoTranscript)
		return
	}
	if !rewrite {
		// A look, as the highlights': what is kept, or not_started. Never a call.
		if !found {
			reply(types.ReelsResponse{Status: types.HighlightsNotStarted, Reels: []types.Reel{}})
			return
		}
		reply(reelsResponse(row))
		return
	}
	if err := s.aiCapCheck(ctx, types.AIFeatureReels, rc.wb.Host.ID); errors.Is(err, errAILimit) {
		httpx.Error(w, http.StatusTooManyRequests, "ai_limit", aiLimitMessage)
		return
	} else if err != nil {
		s.fail(w, r, "reels: cap", err)
		return
	}
	claimed, err := s.store.ClaimRecordingReels(ctx, rc.sessionID, true, highlightsClaimFor)
	if err != nil {
		s.fail(w, r, "reels: claim", err)
		return
	}
	if claimed {
		s.planReels(ctx, rc.wb, rc.sessionID, m)
	}
	row, err = s.store.RecordingReels(ctx, rc.sessionID)
	if err != nil {
		s.fail(w, r, "reels: read back", err)
		return
	}
	reply(reelsResponse(row))
}

// planReels is the claimed write, its outcome stored whatever the caller does meanwhile.
func (s *Server) planReels(parent context.Context, wb types.Webinar, sessionID string, m highlightMaterial) {
	bg := context.WithoutCancel(parent)
	ctx, cancel := context.WithTimeout(bg, highlightsBudget)
	defer cancel()
	body, model, err := s.writeReels(ctx, wb, m)
	switch {
	case errors.Is(err, errAILimit):
		_ = s.store.FailRecordingReels(bg, sessionID, aiStatusLimit, 0)
	case errors.Is(err, ai.ErrUnavailable):
		_ = s.store.FailRecordingReels(bg, sessionID, aiStatusUnavailable, highlightsRetryAfter)
	case err != nil:
		s.log.Warn("reels: write", "slug", wb.ID, "recording", sessionID, "error", err)
		_ = s.store.FailRecordingReels(bg, sessionID, aiStatusFailed, highlightsRetryAfter)
	default:
		if err := s.store.SaveRecordingReels(bg, sessionID, body, model); err != nil {
			s.log.Error("reels: save", "slug", wb.ID, "recording", sessionID, "error", err)
			_ = s.store.FailRecordingReels(bg, sessionID, aiStatusFailed, highlightsRetryAfter)
			return
		}
		s.log.Info("reels written", "slug", wb.ID, "recording", sessionID, "model", model, "reels", len(body.Reels))
	}
}
