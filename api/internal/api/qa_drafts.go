package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Draft answers: the Q&A assistant's answers, grounded in the host's AI knowledge
 * (knowledge.go), for the host and co-hosts to review. The audience never sees a draft.
 *
 *   suggest   "✨ Suggest an answer" on a cluster: one call, with the session's best knowledge
 *             chunks for the question and the last few minutes of transcript.
 *   auto      after a grouping pass, the new clusters the knowledge has hits for are drafted
 *             unasked, all in ONE call (qaAutoDraft), at most qaAutoDraftBatch a pass and
 *             qaAutoDraftCap a session. No hits, no draft: a general answer is not worth a
 *             call nobody asked for.
 *   post      a host (after editing, if they like) posts the draft: it becomes the host's
 *             answer on each of the cluster's open questions through the ordinary answer path
 *             (UpdateSessionQuestion and the room's qmod packet, what "Send answer" does).
 *   discard   the draft goes; an automatic one is not written again for that question.
 *
 * A draft the knowledge did not cover is marked grounded:false and, when the session has
 * knowledge, opens with "Not in your knowledge — general answer:". Its sources are the titles
 * of the documents its excerpts came from, mapped here from the labels the model cited. */

var (
	// qaAutoDraftCap is the most automatic drafts one session gets. A var for tests.
	qaAutoDraftCap = 30
)

const (
	// qaAutoDraftBatch is the most clusters one automatic-draft call answers.
	qaAutoDraftBatch = 5
	// qaAutoDraftTimeout bounds the automatic-draft call.
	qaAutoDraftTimeout = 25 * time.Second
)

func newQADraftID() string {
	var b [10]byte
	_, _ = rand.Read(b[:])
	return "qd_" + hex.EncodeToString(b[:])
}

// excerptPool is the knowledge chunks a call is given, each once, labelled in order.
type excerptPool struct {
	hits  []store.KnowledgeHit
	index map[string]int
}

func (p *excerptPool) add(h store.KnowledgeHit) int {
	if p.index == nil {
		p.index = map[string]int{}
	}
	key := h.DocID + "#" + strconv.Itoa(h.Seq)
	if i, ok := p.index[key]; ok {
		return i
	}
	p.index[key] = len(p.hits)
	p.hits = append(p.hits, h)
	return len(p.hits) - 1
}

func (p *excerptPool) excerpts() []aiwrite.QAExcerpt {
	out := make([]aiwrite.QAExcerpt, len(p.hits))
	for i, h := range p.hits {
		out[i] = aiwrite.QAExcerpt{Title: h.Title, Text: h.Text}
	}
	return out
}

// titles is the documents behind the cited excerpts, each once, in citation order.
func (p *excerptPool) titles(sources []int) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, i := range sources {
		if i < 0 || i >= len(p.hits) {
			continue
		}
		if t := p.hits[i].Title; !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

func draftView(d store.QADraft) *types.QADraft {
	sources := d.Sources
	if sources == nil {
		sources = []string{}
	}
	return &types.QADraft{
		ID: d.ID, Answer: d.Answer, Grounded: d.Grounded, Sources: sources, Auto: d.Auto,
		CreatedAt: d.CreatedAt.UTC().Format(time.RFC3339),
	}
}

/* attachQADrafts puts each open draft on its cluster: the one written for the cluster, or
 * else one written for any of its questions while it was ungrouped. The newest wins. */
func attachQADrafts(cs []types.QACluster, drafts []store.QADraft) {
	byKey := map[string]store.QADraft{}
	for _, d := range drafts { // oldest first, so a newer one replaces an older
		byKey[d.ClusterKey] = d
	}
	for i := range cs {
		c := &cs[i]
		var best *store.QADraft
		if d, ok := byKey[c.ID]; ok {
			best = &d
		}
		for _, qid := range c.QuestionIDs {
			if d, ok := byKey[qaProvisional+qid]; ok && (best == nil || d.CreatedAt.After(best.CreatedAt)) {
				best = &d
			}
		}
		if best != nil {
			c.Draft = draftView(*best)
		}
	}
}

// ---------------------------------------------------------------- automatic drafts

/* qaAutoDraft drafts the new clusters of a pass that the knowledge has something for, in one
 * call. members are each new cluster's questions (ids and texts). Returns how many drafts it
 * saved; errAILimit at a cap. */
func (s *Server) qaAutoDraft(ctx context.Context, wb types.Webinar, created []store.QANewCluster, members map[string][]store.QAQuestion) (int, error) {
	if len(created) == 0 {
		return 0, nil
	}
	slug := wb.ID
	has, err := s.store.SessionHasKnowledge(ctx, slug)
	if err != nil || !has {
		return 0, err
	}
	done, err := s.store.QAAutoDraftCount(ctx, slug)
	if err != nil {
		return 0, err
	}
	room := min(qaAutoDraftCap-done, qaAutoDraftBatch)
	if room <= 0 {
		return 0, nil
	}
	keys, err := s.store.QADraftKeys(ctx, slug)
	if err != nil {
		return 0, err
	}

	var (
		pool    excerptPool
		items   []aiwrite.QADraftItem
		targets []string
	)
	for _, c := range created {
		if len(items) == room {
			break
		}
		if keys[c.ID] {
			continue
		}
		var asked []string
		drafted := false
		for _, q := range members[c.ID] {
			asked = append(asked, q.Text)
			drafted = drafted || keys[qaProvisional+q.ID]
		}
		if drafted {
			continue
		}
		hits, err := s.retrieveKnowledge(ctx, slug, c.Canonical+" "+strings.Join(asked, " "), autoDraftTopChunks, autoDraftTokenBudget)
		if err != nil {
			return 0, err
		}
		if len(hits) == 0 {
			continue
		}
		it := aiwrite.QADraftItem{Question: c.Canonical, Asked: asked}
		for _, h := range hits {
			it.Excerpts = append(it.Excerpts, pool.add(h))
		}
		items = append(items, it)
		targets = append(targets, c.ID)
	}
	if len(items) == 0 {
		return 0, nil
	}

	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), qaAutoDraftTimeout)
	defer cancel()
	description := wb.Summary
	if d := strings.TrimSpace(wb.Descript); d != "" {
		description = d
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureQAAutoDraft, wb.Host.ID, ai.Request{
		Messages:       aiwrite.QADraftBatchMessages(wb.Topic, description, pool.excerpts(), items),
		Schema:         aiwrite.QADraftBatchSchema,
		MaxTokens:      300*len(items) + 400,
		Temperature:    0.2,
		AttemptTimeout: 20 * time.Second,
	})
	if err != nil {
		return 0, err
	}
	answers, err := aiwrite.ParseQADraftBatch(reply.Text, len(items), len(pool.hits))
	if err != nil {
		return 0, err
	}
	saved := 0
	for i, cid := range targets {
		a, ok := answers[i]
		if !ok {
			continue
		}
		text := aiwrite.FinishQAAnswer(a, true)
		if text == "" {
			continue
		}
		if err := s.store.SaveQADraft(ctx, slug, store.QADraft{
			ID: newQADraftID(), ClusterKey: cid, Answer: text, Grounded: a.Grounded,
			Sources: pool.titles(a.Sources), Auto: true,
		}); err != nil {
			return saved, err
		}
		saved++
	}
	return saved, nil
}

// ---------------------------------------------------------------- handlers

// handleQASuggest is POST /api/host/webinars/{slug}/qa/clusters/{id}/suggest: one call, a
// draft for the host team, kept as the cluster's draft. Nothing is posted.
func (s *Server) handleQASuggest(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "qa suggest: webinar", err)
		return
	}
	if !s.sessionAIAllowed(r.Context(), wb) {
		httpx.Error(w, http.StatusForbidden, "ai_off", "AI is off for this session.")
		return
	}

	in := aiwrite.QAAnswerInput{Topic: wb.Topic, Description: wb.Summary}
	if d := strings.TrimSpace(wb.Descript); d != "" {
		in.Description = d
	}
	if qid, ok := strings.CutPrefix(id, qaProvisional); ok {
		text, err := s.store.QAQuestionText(r.Context(), slug, qid)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That question isn't in this session.")
			return
		}
		if err != nil {
			s.fail(w, r, "qa suggest: question", err)
			return
		}
		in.Question, in.Asked = text, []string{text}
	} else {
		canonical, err := s.store.QAClusterCanonical(r.Context(), slug, id)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That question isn't in this session.")
			return
		}
		if err != nil {
			s.fail(w, r, "qa suggest: cluster", err)
			return
		}
		asked, err := s.store.QAQuestionTexts(r.Context(), slug, id, 5)
		if err != nil {
			s.fail(w, r, "qa suggest: questions", err)
			return
		}
		in.Question, in.Asked = canonical, asked
	}

	user := userFromContext(r.Context())
	if ok, retry := s.aiWriteLimit.Allow(user.ID); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "That's a lot of drafts in a minute. Try again shortly.")
		return
	}

	// The knowledge: the best chunks for the question; with none, topic and description only.
	var pool excerptPool
	if in.HasKnowledge, err = s.store.SessionHasKnowledge(r.Context(), slug); err != nil {
		s.log.Warn("qa suggest: knowledge", "slug", slug, "error", err)
	}
	if in.HasKnowledge {
		hits, err := s.retrieveKnowledge(r.Context(), slug, in.Question+" "+strings.Join(in.Asked, " "), knowledgeTopChunks, knowledgeTokenBudget)
		if err != nil {
			s.log.Warn("qa suggest: retrieve", "slug", slug, "error", err)
		}
		for _, h := range hits {
			pool.add(h)
		}
		in.Knowledge = pool.excerpts()
	}

	lines, err := s.store.RecapCaptions(r.Context(), slug, time.Now().Add(-qaAnswerTranscript), 400)
	if err != nil {
		s.log.Warn("qa suggest: captions", "slug", slug, "error", err)
	}
	for _, l := range lines {
		name := l.Name
		if name == "" {
			name = "Speaker"
		}
		in.Recent = append(in.Recent, name+": "+l.Text)
	}

	ctx, cancel := context.WithTimeout(r.Context(), 19*time.Second)
	defer cancel()
	// Charged to the session's host, whose allowance it is, whichever co-host clicked.
	reply, err := s.aiComplete(ctx, types.AIFeatureQAAnswer, wb.Host.ID, ai.Request{
		Messages:       aiwrite.QAAnswerMessages(in),
		Schema:         aiwrite.QAAnswerSchema,
		MaxTokens:      600,
		Temperature:    0.2,
		AttemptTimeout: 15 * time.Second,
	})
	switch {
	case errors.Is(err, errAILimit):
		httpx.Error(w, http.StatusTooManyRequests, "ai_limit",
			aiLimitMessage+" Suggested answers are paused; you can still answer by hand.")
		return
	case errors.Is(err, ai.ErrUnavailable):
		httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
			"Suggested answers aren't available right now. Try again in a minute.")
		return
	case err != nil:
		s.fail(w, r, "qa suggest", err)
		return
	}
	parsed := aiwrite.ParseQAAnswer(reply.Text, len(pool.hits), len(in.Recent) > 0)
	answer := aiwrite.FinishQAAnswer(parsed, in.HasKnowledge)
	if answer == "" {
		httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
			"Suggested answers aren't available right now. Try again in a minute.")
		return
	}
	d := store.QADraft{
		ID: newQADraftID(), ClusterKey: id, Answer: answer, Grounded: parsed.Grounded,
		Sources: pool.titles(parsed.Sources), CreatedAt: time.Now(),
	}
	if err := s.store.SaveQADraft(context.WithoutCancel(r.Context()), slug, d); err != nil {
		s.fail(w, r, "qa suggest: save", err)
		return
	}
	// The other hosts' panels show it too.
	s.announceQAClusters(context.WithoutCancel(r.Context()), wb)
	httpx.JSON(w, http.StatusOK, types.QASuggestResponse{Answer: answer, Draft: *draftView(d)})
}

/* handleQAPostDraft is POST /api/host/webinars/{slug}/qa/drafts/{id}/post: the draft, as the
 * host edited it, becomes the host's answer on each open question of its cluster, through the
 * ordinary answer path, and the room is told. The only way a draft reaches the audience. */
func (s *Server) handleQAPostDraft(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "qa post: webinar", err)
		return
	}
	if !s.sessionAIAllowed(r.Context(), wb) {
		httpx.Error(w, http.StatusForbidden, "ai_off", "AI is off for this session.")
		return
	}
	var in types.QAPostDraftRequest
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	answer := strings.TrimSpace(in.Answer)
	switch {
	case answer == "":
		httpx.Fields(w, map[string]string{"answer": "Write the answer to post."})
		return
	case utf8.RuneCountInString(answer) > types.QAAnswerMaxRunes:
		httpx.Fields(w, map[string]string{"answer": "Keep it under " + strconv.Itoa(types.QAAnswerMaxRunes) + " characters."})
		return
	}
	d, err := s.store.QADraftByID(r.Context(), slug, id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That draft is gone. It may have been posted or discarded already.")
		return
	}
	if err != nil {
		s.fail(w, r, "qa post: draft", err)
		return
	}
	clusterID, questionID := d.ClusterKey, ""
	if qid, ok := strings.CutPrefix(d.ClusterKey, qaProvisional); ok {
		clusterID, questionID = "", qid
	}
	ids, err := s.store.QAOpenQuestionIDs(r.Context(), slug, clusterID, questionID)
	if err != nil {
		s.fail(w, r, "qa post: questions", err)
		return
	}
	if len(ids) == 0 {
		httpx.Error(w, http.StatusConflict, "already_answered", "Those questions are already answered.")
		return
	}
	// Closed first, so two co-hosts clicking Post at once post it once.
	ok, err := s.store.CloseQADraft(r.Context(), slug, id, store.QADraftPosted, answer)
	if err != nil {
		s.fail(w, r, "qa post: close", err)
		return
	}
	if !ok {
		httpx.Error(w, http.StatusNotFound, "not_found", "That draft is gone. It may have been posted or discarded already.")
		return
	}
	bg := context.WithoutCancel(r.Context())
	answered := true
	for _, qid := range ids {
		if err := s.store.UpdateSessionQuestion(bg, slug, qid, types.QuestionPatch{Answered: &answered, Answer: &answer}); err != nil {
			s.fail(w, r, "qa post: answer", err)
			return
		}
	}
	s.broadcastAnswers(bg, wb, ids, answer)
	s.announceQAClusters(bg, wb)
	httpx.JSON(w, http.StatusOK, types.QAPostDraftResponse{QuestionIDs: ids, Answer: answer})
}

// broadcastAnswers is the room's qmod packet for each answered question, as a host's "Send
// answer" sends it. Best effort: the posting host's panel sends the same packets too, and a
// reload reads the stored answers.
func (s *Server) broadcastAnswers(ctx context.Context, wb types.Webinar, ids []string, answer string) {
	if wb.SFUProject == "" {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	for _, id := range ids {
		if err := s.sendRoomPacket(ctx, sfu, wb.ID, nil, map[string]any{
			"kind": "qmod", "questionId": id, "answered": true, "answer": answer,
		}); err != nil {
			s.log.Warn("qa post: packet", "slug", wb.ID, "error", err)
			return
		}
	}
}

// handleQADiscardDraft is DELETE /api/host/webinars/{slug}/qa/drafts/{id}.
func (s *Server) handleQADiscardDraft(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "qa discard: webinar", err)
		return
	}
	ok, err := s.store.CloseQADraft(r.Context(), slug, chi.URLParam(r, "id"), store.QADraftDiscarded, "")
	if err != nil {
		s.fail(w, r, "qa discard", err)
		return
	}
	if !ok {
		httpx.Error(w, http.StatusNotFound, "not_found", "That draft is gone. It may have been posted or discarded already.")
		return
	}
	s.announceQAClusters(context.WithoutCancel(r.Context()), wb)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}
