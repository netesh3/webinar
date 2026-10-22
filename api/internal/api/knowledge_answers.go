package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* "✨ Past answers": the answers a host has already given in their sessions, kept as entries of
 * their AI knowledge so the Q&A assistant can draft from them next time.
 *
 *   typed      when a session ends (endWebinarSession), every question the host answered in
 *              the Q&A panel becomes an entry, approved at once: it was already posted. A
 *              draft the host edited before posting is saved as posted, since the posted
 *              answer is what session_questions holds. A cluster is one entry, under its
 *              wording. Unanswered and hidden questions are skipped.
 *   aloud      once the session's transcript has settled (the recap is no longer waiting for
 *              it), the questions with no typed answer and the transcript go to the model in
 *              ONE call (feature "qa_harvest"); each question it finds answered out loud
 *              becomes a pending entry for the host to approve, edit or skip. Pending entries
 *              are never retrieved. Run inline in the requests that are there anyway: the
 *              Results page's recap poll and the library's read (Cloud Run has no scheduler).
 *   backfill   sessions that ended before this existed, or whose harvest did not run, are
 *              harvested when the host opens their past answers: typed for up to
 *              harvestBackfillSessions sessions a read, aloud for one (ended within
 *              harvestAloudWindow).
 *   repeats    a new approved answer to a question an entry already holds (same question by
 *              embedding, or by words without one) updates that entry, keeping the version it
 *              replaced for one Undo.
 *   privacy    the question and the answer only, never who asked; phones and emails scrubbed
 *              (knowledge.ScrubPII) before anything is stored or embedded.
 *
 * A session whose AI switch was off (sessionAIAllowed) is never harvested: nothing of it goes
 * to a model, embeddings included. Each session's questions are harvested once
 * (knowledge_answer_sources), so a deleted or skipped entry does not come back. */

const (
	// harvestBackfillSessions bounds the typed harvests one read of the library does.
	harvestBackfillSessions = 20
	// harvestAloudWindow is how far back the answered-aloud backfill looks.
	harvestAloudWindow = 30 * 24 * time.Hour
	// harvestAloudTimeout bounds the answered-aloud call.
	harvestAloudTimeout = 30 * time.Second
	// harvestTranscriptLines bounds the caption lines read for it.
	harvestTranscriptLines = 20000
)

// The answered-aloud pass's outcomes, as knowledge_harvests.aloud_reason records them.
const (
	aloudDrafted      = "drafted"
	aloudNone         = "none"
	aloudNoTranscript = "no_transcript"
	aloudAIOff        = "ai_off"
	aloudLimit        = "limit"
	aloudFailed       = "failed"
)

// pastAnswerText is a question or answer as stored: one paragraph, scrubbed, clipped.
func pastAnswerText(s string, maxRunes int) string {
	return clipRunes(strings.TrimSpace(knowledge.ScrubPII(strings.Join(strings.Fields(s), " "))), maxRunes)
}

func harvestSessionOf(wb types.Webinar) store.HarvestSession {
	h := store.HarvestSession{Slug: wb.ID, Topic: wb.Topic}
	if t, err := time.Parse(time.RFC3339, wb.EndedAt); err == nil {
		h.EndedAt = t
	}
	return h
}

/* harvestTyped saves the typed answers of one ended session as approved entries. Nothing for
 * an account without the ai feature; a session whose AI switch was off is marked done
 * without anything saved. */
func (s *Server) harvestTyped(ctx context.Context, wb types.Webinar, hs store.HarvestSession) {
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil || !host.HasFeature(types.FeatureAIKnowledge) {
		return
	}
	webinarID, err := s.store.WebinarIDBySlug(ctx, wb.ID)
	if err != nil {
		s.log.Warn("past answers: webinar", "slug", wb.ID, "error", err)
		return
	}
	if !s.sessionAIAllowed(ctx, wb) {
		_ = s.store.MarkTypedHarvested(ctx, webinarID, host.ID)
		return
	}
	qs, err := s.store.HarvestQuestions(ctx, webinarID)
	if err != nil {
		s.log.Warn("past answers: questions", "slug", wb.ID, "error", err)
		return
	}
	var items []store.PastAnswerIn
	for _, q := range qs {
		if q.Answer == "" {
			continue
		}
		in := store.PastAnswerIn{
			Key: q.Key, WebinarID: webinarID, Topic: hs.Topic, At: hs.EndedAt,
			Question: pastAnswerText(q.Question, types.PastAnswerMaxQuestionRunes),
			Answer:   pastAnswerText(q.Answer, types.PastAnswerMaxAnswerRunes),
			Status:   types.PastAnswerApproved, Origin: types.PastAnswerTyped,
		}
		if in.Question != "" && in.Answer != "" {
			items = append(items, in)
		}
	}
	if len(items) > 0 {
		texts := make([]string, len(items))
		for i, in := range items {
			texts[i] = in.Question
		}
		for i, v := range s.queryVectors(ctx, host.ID, texts) {
			items[i].Vec = v
		}
		added, updated, err := s.store.SavePastAnswers(ctx, host.ID, items)
		if err != nil {
			s.log.Warn("past answers: save", "slug", wb.ID, "error", err)
			return
		}
		s.log.Info("past answers: typed harvested", "slug", wb.ID, "added", added, "updated", updated)
	}
	if err := s.store.MarkTypedHarvested(ctx, webinarID, host.ID); err != nil {
		s.log.Warn("past answers: mark", "slug", wb.ID, "error", err)
	}
}

// harvestOnEnd is endWebinarSession's hook: the typed answers, at once.
func (s *Server) harvestOnEnd(ctx context.Context, wb types.Webinar) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	hs := harvestSessionOf(wb)
	if hs.EndedAt.IsZero() {
		hs.EndedAt = time.Now()
	}
	s.harvestTyped(ctx, wb, hs)
}

/* aloudDue is whether a session's transcript has settled: the after-session transcript has
 * arrived, or the recap is not waiting for one (it is written, skipped or given up), or the
 * session ended longer ago than any recap waits. */
func (s *Server) aloudDue(ctx context.Context, wb types.Webinar, hs store.HarvestSession) bool {
	if !hs.EndedAt.IsZero() && time.Since(hs.EndedAt) > recapTranscriptWait+5*time.Minute {
		return true
	}
	row, err := s.store.SessionRecap(ctx, wb.ID)
	if errors.Is(err, store.ErrNotFound) {
		return true
	}
	return err == nil && row.Status != types.RecapPending
}

// sessionTranscript is what was said in a session, "Speaker: text": the after-session
// transcript when there is one, else the live caption lines.
func (s *Server) sessionTranscript(ctx context.Context, wb types.Webinar) ([]string, error) {
	var started time.Time
	if wb.StartedAt != "" {
		started, _ = time.Parse(time.RFC3339, wb.StartedAt)
	}
	var out []string
	_, segs, found, err := s.store.TranscriptSince(ctx, wb.ID, started)
	if err != nil {
		return nil, err
	}
	if found && len(segs) > 0 {
		for _, sg := range segs {
			name := sg.Name
			if name == "" {
				name = speakerLabel(sg.Identity, wb)
			}
			out = append(out, name+": "+sg.Text)
		}
		return out, nil
	}
	lines, err := s.store.RecapCaptions(ctx, wb.ID, started, harvestTranscriptLines)
	if err != nil {
		return nil, err
	}
	for _, l := range lines {
		name := l.Name
		if name == "" {
			name = speakerLabel(l.Identity, wb)
		}
		out = append(out, name+": "+l.Text)
	}
	return out, nil
}

/* harvestAloud is the answered-aloud pass for one ended session, if it is due and nobody has
 * run it: one model call, pending entries. Reports whether it drafted anything. A cap or an
 * unavailable provider hands the pass back, to run on a later request. */
func (s *Server) harvestAloud(ctx context.Context, wb types.Webinar, hs store.HarvestSession) bool {
	if wb.Status != types.StatusEnded {
		return false
	}
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil || !host.HasFeature(types.FeatureAIKnowledge) {
		return false
	}
	webinarID, err := s.store.WebinarIDBySlug(ctx, wb.ID)
	if err != nil {
		return false
	}
	if !s.sessionAIAllowed(ctx, wb) {
		if ok, _ := s.store.ClaimAloudHarvest(ctx, webinarID, host.ID); ok {
			_ = s.store.SettleAloudHarvest(ctx, webinarID, aloudAIOff, false)
		}
		return false
	}
	if !s.ai.Enabled() || !s.aloudDue(ctx, wb, hs) {
		return false
	}
	ok, err := s.store.ClaimAloudHarvest(ctx, webinarID, host.ID)
	if err != nil || !ok {
		return false
	}
	bg := context.WithoutCancel(ctx)
	settle := func(reason string, release bool) {
		if err := s.store.SettleAloudHarvest(bg, webinarID, reason, release); err != nil {
			s.log.Warn("past answers: settle", "slug", wb.ID, "error", err)
		}
	}

	qs, err := s.store.HarvestQuestions(ctx, webinarID)
	if err != nil {
		settle(aloudFailed, true)
		return false
	}
	var open []store.HarvestQuestion
	for _, q := range qs {
		if q.Answer == "" {
			open = append(open, q)
		}
	}
	// Marked answered first (the host said they answered it), then the most wanted.
	sort.SliceStable(open, func(i, j int) bool {
		if open[i].Answered != open[j].Answered {
			return open[i].Answered
		}
		return open[i].Upvotes > open[j].Upvotes
	})
	if len(open) > aiwrite.MaxHarvestQuestions {
		open = open[:aiwrite.MaxHarvestQuestions]
	}
	if len(open) == 0 {
		settle(aloudNone, false)
		return false
	}
	lines, err := s.sessionTranscript(ctx, wb)
	if err != nil {
		settle(aloudFailed, true)
		return false
	}
	if len(lines) == 0 {
		settle(aloudNoTranscript, false)
		return false
	}
	questions := make([]string, len(open))
	for i, q := range open {
		questions[i] = q.Question
	}
	cctx, cancel := context.WithTimeout(ctx, harvestAloudTimeout)
	defer cancel()
	reply, err := s.aiComplete(cctx, types.AIFeatureQAHarvest, host.ID, ai.Request{
		Messages:       aiwrite.QAHarvestMessages(wb.Topic, questions, lines),
		Schema:         aiwrite.QAHarvestSchema,
		MaxTokens:      250*len(open) + 400,
		Temperature:    0.1,
		AttemptTimeout: 25 * time.Second,
	})
	switch {
	case errors.Is(err, errAILimit):
		settle(aloudLimit, true)
		return false
	case err != nil:
		s.log.Info("past answers: aloud pass", "slug", wb.ID, "error", err)
		settle(aloudFailed, true)
		return false
	}
	answers, err := aiwrite.ParseQAHarvest(reply.Text, len(open))
	if err != nil {
		settle(aloudFailed, false)
		return false
	}
	var items []store.PastAnswerIn
	for i, q := range open {
		a, ok := answers[i]
		if !ok {
			continue
		}
		in := store.PastAnswerIn{
			Key: q.Key, WebinarID: webinarID, Topic: hs.Topic, At: hs.EndedAt,
			Question: pastAnswerText(q.Question, types.PastAnswerMaxQuestionRunes),
			Answer:   pastAnswerText(a, types.PastAnswerMaxAnswerRunes),
			Status:   types.PastAnswerPending, Origin: types.PastAnswerAloud,
		}
		if in.Question != "" && in.Answer != "" {
			items = append(items, in)
		}
	}
	added, _, err := s.store.SavePastAnswers(bg, host.ID, items)
	if err != nil {
		s.log.Warn("past answers: save drafts", "slug", wb.ID, "error", err)
		settle(aloudFailed, false)
		return false
	}
	if added == 0 {
		settle(aloudNone, false)
		return false
	}
	settle(aloudDrafted, false)
	s.log.Info("past answers: aloud drafted", "slug", wb.ID, "drafts", added)
	return true
}

// harvestAloudForSlug is harvestAloud for the session a request is about (the recap poll).
func (s *Server) harvestAloudForSlug(ctx context.Context, slug string) {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return
	}
	s.harvestAloud(ctx, wb, harvestSessionOf(wb))
}

// harvestBackfill is the library read's catch-up: typed answers of sessions not yet
// harvested, and the answered-aloud pass of one recent session.
func (s *Server) harvestBackfill(ctx context.Context, hostID string) {
	sessions, err := s.store.SessionsToHarvest(ctx, hostID, harvestBackfillSessions)
	if err != nil {
		s.log.Warn("past answers: backfill", "error", err)
		return
	}
	for _, hs := range sessions {
		wb, err := s.store.WebinarBySlug(ctx, hs.Slug)
		if err != nil {
			continue
		}
		s.harvestTyped(ctx, wb, hs)
	}
	recent, err := s.store.SessionsToHarvestAloud(ctx, hostID, time.Now().Add(-harvestAloudWindow), 5)
	if err != nil {
		return
	}
	for _, hs := range recent {
		wb, err := s.store.WebinarBySlug(ctx, hs.Slug)
		if err != nil {
			continue
		}
		// One call a read at most: the rest wait for the next.
		if s.harvestAloud(ctx, wb, hs) {
			return
		}
	}
}

// ---------------------------------------------------------------- handlers

func pastAnswerNotFound(w http.ResponseWriter) {
	httpx.Error(w, http.StatusNotFound, "not_found", "That answer isn't in your AI knowledge.")
}

// handlePastAnswers is GET /api/host/knowledge/answers.
func (s *Server) handlePastAnswers(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	s.harvestBackfill(r.Context(), user.ID)
	s.backfillEmbeddings(r.Context(), user.ID)
	list, err := s.store.PastAnswers(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "past answers: list", err)
		return
	}
	out := types.PastAnswers{Answers: list, Max: types.PastAnswerMaxEntries}
	for _, a := range list {
		if a.Status == types.PastAnswerPending {
			out.Pending++
		} else {
			out.Approved++
		}
	}
	httpx.JSON(w, http.StatusOK, out)
}

// pastAnswerEdit reads and checks an edit; ok false when it answered already. With partial,
// an empty field keeps the entry's own text.
func pastAnswerEdit(w http.ResponseWriter, r *http.Request, cur types.PastAnswer, partial bool) (string, string, bool) {
	var in types.PastAnswerEdit
	if r.ContentLength != 0 {
		if err := httpx.DecodeJSON(w, r, &in); err != nil {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
			return "", "", false
		}
	}
	q, a := strings.TrimSpace(in.Question), strings.TrimSpace(in.Answer)
	if partial && q == "" {
		q = cur.Question
	}
	if partial && a == "" {
		a = cur.Answer
	}
	fields := map[string]string{}
	switch {
	case q == "":
		fields["question"] = "Write the question."
	case utf8.RuneCountInString(q) > types.PastAnswerMaxQuestionRunes:
		fields["question"] = "Keep it under " + strconv.Itoa(types.PastAnswerMaxQuestionRunes) + " characters."
	}
	switch {
	case a == "":
		fields["answer"] = "Write the answer."
	case utf8.RuneCountInString(a) > types.PastAnswerMaxAnswerRunes:
		fields["answer"] = "Keep it under " + strconv.Itoa(types.PastAnswerMaxAnswerRunes) + " characters."
	}
	if len(fields) > 0 {
		httpx.Fields(w, fields)
		return "", "", false
	}
	return pastAnswerText(q, types.PastAnswerMaxQuestionRunes), pastAnswerText(a, types.PastAnswerMaxAnswerRunes), true
}

// writePastAnswer is one entry, re-read, 200.
func (s *Server) writePastAnswer(w http.ResponseWriter, r *http.Request, hostID, id string, merged bool) {
	a, err := s.store.PastAnswer(r.Context(), hostID, id)
	if err != nil {
		s.fail(w, r, "past answers: read", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.PastAnswerResult{Answer: a, Merged: merged})
}

// handleEditPastAnswer is PATCH /api/host/knowledge/answers/{id}: a correction.
func (s *Server) handleEditPastAnswer(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	id := chi.URLParam(r, "id")
	cur, err := s.store.PastAnswer(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		pastAnswerNotFound(w)
		return
	}
	if err != nil {
		s.fail(w, r, "past answers: read", err)
		return
	}
	q, a, ok := pastAnswerEdit(w, r, cur, false)
	if !ok {
		return
	}
	if err := s.store.EditPastAnswer(r.Context(), user.ID, id, q, a); errors.Is(err, store.ErrNotFound) {
		pastAnswerNotFound(w)
		return
	} else if err != nil {
		s.fail(w, r, "past answers: edit", err)
		return
	}
	s.backfillEmbeddings(r.Context(), user.ID)
	s.writePastAnswer(w, r, user.ID, id, false)
}

// handleApprovePastAnswer is POST /api/host/knowledge/answers/{id}/approve: a pending draft,
// as the host edited it.
func (s *Server) handleApprovePastAnswer(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	id := chi.URLParam(r, "id")
	cur, err := s.store.PastAnswer(r.Context(), user.ID, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && cur.Status != types.PastAnswerPending) {
		pastAnswerNotFound(w)
		return
	}
	if err != nil {
		s.fail(w, r, "past answers: read", err)
		return
	}
	q, a, ok := pastAnswerEdit(w, r, cur, true)
	if !ok {
		return
	}
	vec := s.queryVectors(r.Context(), user.ID, []string{q})[0]
	into, merged, err := s.store.ApprovePastAnswer(r.Context(), user.ID, id, q, a, vec)
	if errors.Is(err, store.ErrNotFound) {
		pastAnswerNotFound(w)
		return
	}
	if err != nil {
		s.fail(w, r, "past answers: approve", err)
		return
	}
	s.writePastAnswer(w, r, user.ID, into, merged)
}

// handleUndoPastAnswer is POST /api/host/knowledge/answers/{id}/undo: the version a repeat
// replaced, back.
func (s *Server) handleUndoPastAnswer(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	id := chi.URLParam(r, "id")
	if err := s.store.UndoPastAnswer(r.Context(), user.ID, id); errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "There's nothing to undo on that answer.")
		return
	} else if err != nil {
		s.fail(w, r, "past answers: undo", err)
		return
	}
	s.backfillEmbeddings(r.Context(), user.ID)
	s.writePastAnswer(w, r, user.ID, id, false)
}

// handleDeletePastAnswer is DELETE /api/host/knowledge/answers/{id} (Skip, for a draft).
func (s *Server) handleDeletePastAnswer(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureAIKnowledge) {
		return
	}
	if err := s.store.DeletePastAnswer(r.Context(), user.ID, chi.URLParam(r, "id")); errors.Is(err, store.ErrNotFound) {
		pastAnswerNotFound(w)
		return
	} else if err != nil {
		s.fail(w, r, "past answers: delete", err)
		return
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}
