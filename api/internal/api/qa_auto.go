package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Auto mode: in a simulive the host may not be online, so the assistant answers the live
 * audience's NEW questions from the host's AI knowledge (documents and approved past answers),
 * and posts the answer without anybody approving it. That is the whole point of it, so it is
 * fenced in:
 *
 *   switch     per simulive (options.simuliveAutoAnswer), off by default, and only with the
 *              account features ai AND replay_engage, and only while sessionAIAllowed (the
 *              room's AI switch). Q&A questions only: chat is never auto-answered.
 *   grounded   only an answer the knowledge covers is posted (aiwrite.ParseQAAuto: grounded
 *              AND citing an excerpt it was given). Anything else stays open for the host, and
 *              the audience sees nothing about it. A question with no knowledge hits costs no call.
 *   signed     "✨ <First name>'s assistant" (assistantLabel), on the answer as everyone sees it
 *              (session_questions.answer_by, the qmod packet's answerBy). Never the host's name
 *              or avatar as the author, and there is no option to hide that it is an assistant.
 *   limits     at most qaAutoSessionCap answers a session and qaAutoPerAsker per asker in
 *              qaAutoAskerWindow; the rest stay open for the host ('limited'). Feature "qa_auto"
 *              in ai_usage, under the host's monthly caps (aiComplete).
 *   privacy    emails and phone numbers are scrubbed from a question before it is searched,
 *              embedded or sent to the model (knowledge.ScrubPII).
 *   host       a host or co-host who drops in sees "✨ Auto-answered" with Edit (the ordinary
 *              answer path; the edited answer is the host team's) and Retract (handleRetract
 *              AutoAnswer: the question is open again and the answer gone for everyone).
 *
 * WHERE IT RUNS. Cloud Run gives a container CPU only while it is serving a request, so nothing
 * here runs in a goroutine that outlives one. The ask (handleSay) only marks the question
 * 'pending' and tells the asker's browser to come back in qaAutoDelay; that browser's POST
 * /qa/auto is the request the batch is answered in, inline. Everything waiting by then — every
 * question asked in those few seconds, by anyone — is claimed (ClaimAutoQuestions, SKIP LOCKED,
 * so two requests never answer the same one) and answered in ONE call. A question whose asker
 * left before their browser came back is picked up by the next one's. */

var (
	// qaAutoDelay is how long the asker's browser waits before asking for the batch: questions
	// asked in that time are answered together. A var for tests.
	qaAutoDelay = 5 * time.Second
	// qaAutoSessionCap is the most answers the assistant posts in one session. A var for tests.
	qaAutoSessionCap = 50
)

const (
	// qaAutoBatch is the most questions one call answers; qaAutoMaxBatches bounds one request.
	qaAutoBatch      = 8
	qaAutoMaxBatches = 3
	// qaAutoPerAsker answers per asker in qaAutoAskerWindow.
	qaAutoPerAsker    = 3
	qaAutoAskerWindow = 5 * time.Minute
	// qaAutoTimeout bounds one batch.
	qaAutoTimeout = 25 * time.Second
)

// assistantLabel is how the assistant signs its answers: the host's first name, never more.
func assistantLabel(hostName string) string {
	if f := strings.Fields(hostName); len(f) > 0 {
		return "✨ " + f[0] + "'s assistant"
	}
	return "✨ The host's assistant"
}

// qaAutoAvailable is whether the host's account may use Auto mode at all.
func (s *Server) qaAutoAvailable(ctx context.Context, hostID string) bool {
	host, err := s.store.UserByID(ctx, hostID)
	return err == nil && host.HasFeature(types.FeatureAI) && host.HasFeature(types.FeatureReplayEngage)
}

/* qaAutoOn is whether Auto mode answers this session's questions right now: a live simulive with
 * the switch on, an account with both features, the AI provider configured, and the session's
 * AI allowed (sessionAIAllowed). */
func (s *Server) qaAutoOn(ctx context.Context, wb types.Webinar) bool {
	// Not once the host team is live after the recording: a human is answering.
	if wb.Kind != types.KindSimulive || !wb.Options.SimuliveAutoAnswer || wb.Status != types.StatusLive ||
		wb.SimuliveLiveAt != "" || !s.ai.Enabled() {
		return false
	}
	return s.sessionAIAllowed(ctx, wb) && s.hostFeature(ctx, wb.Host.ID, types.FeatureReplayEngage)
}

/* qaAutoAsked is handleSay's hook for a new question: in line for the next batch when Auto mode
 * is on and an attendee asked it. Returns how long the asker's browser should wait before asking
 * for the batch (zero: not Auto mode's). */
func (s *Server) qaAutoAsked(ctx context.Context, wb types.Webinar, from wireSender, id string) time.Duration {
	if from.Role != types.RoleAttendee || !s.qaAutoOn(ctx, wb) {
		return 0
	}
	ok, err := s.store.MarkQuestionAutoPending(ctx, wb.ID, id, from.Identity)
	if err != nil {
		s.log.Warn("qa auto: mark pending", "slug", wb.ID, "question", id, "error", err)
		return 0
	}
	if !ok {
		return 0
	}
	return max(qaAutoDelay, time.Millisecond)
}

// handleQAAuto is POST /api/webinars/{slug}/qa/auto: answer the waiting batch, in this request.
func (s *Server) handleQAAuto(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var req types.QAAutoRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	from, ok := s.resolveSender(w, r, slug, req.JoinKey)
	if !ok {
		return
	}
	if allowed, retry := s.sayLimit.Allow(from.Identity); !allowed {
		w.Header().Set("Retry-After", retryAfterSeconds(retry))
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Give it a moment.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "qa auto: load webinar", err)
		return
	}
	n, err := s.runQAAuto(r.Context(), wb)
	if err != nil && !errors.Is(err, errAILimit) && !errors.Is(err, ai.ErrUnavailable) {
		s.log.Warn("qa auto: batch", "slug", slug, "error", err)
	}
	httpx.JSON(w, http.StatusOK, types.QAAutoResponse{Answered: n})
}

/* runQAAuto answers what is waiting, a batch at a time (at most qaAutoMaxBatches). With Auto mode
 * no longer on (switched off, AI switched off, the session over) what is waiting is settled as
 * 'off' with no call. Returns how many answers it posted. */
func (s *Server) runQAAuto(ctx context.Context, wb types.Webinar) (int, error) {
	if wb.Kind != types.KindSimulive {
		return 0, nil
	}
	// Not the caller's to cancel: claimed questions must be settled even if the browser leaves.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), qaAutoTimeout*qaAutoMaxBatches)
	defer cancel()
	on := s.qaAutoOn(ctx, wb)
	posted := 0
	for range qaAutoMaxBatches {
		qs, err := s.store.ClaimAutoQuestions(ctx, wb.ID, qaAutoBatch)
		if err != nil || len(qs) == 0 {
			return posted, err
		}
		if !on {
			if err := s.store.SetAutoState(ctx, wb.ID, autoIDs(qs), store.AutoOff); err != nil {
				return posted, err
			}
			continue
		}
		n, err := s.qaAutoAnswer(ctx, wb, qs)
		posted += n
		if err != nil {
			return posted, err
		}
	}
	return posted, nil
}

func autoIDs(qs []store.AutoQuestion) []string {
	out := make([]string, len(qs))
	for i, q := range qs {
		out[i] = q.ID
	}
	return out
}

/* qaAutoAnswer is one batch: the limits, the knowledge for each question, ONE call for all that
 * have hits, and the grounded answers posted. Every claimed question is settled. */
func (s *Server) qaAutoAnswer(ctx context.Context, wb types.Webinar, qs []store.AutoQuestion) (int, error) {
	slug := wb.ID
	ctx, cancel := context.WithTimeout(ctx, qaAutoTimeout)
	defer cancel()
	settle := func(qs []store.AutoQuestion, state string) {
		if err := s.store.SetAutoState(context.WithoutCancel(ctx), slug, autoIDs(qs), state); err != nil {
			s.log.Warn("qa auto: settle", "slug", slug, "state", state, "error", err)
		}
	}

	// The limits, counted before the call and reserved for this batch.
	total, recent, err := s.store.AutoAnswerCounts(ctx, slug, time.Now().Add(-qaAutoAskerWindow))
	if err != nil {
		settle(qs, store.AutoFailed)
		return 0, err
	}
	room := qaAutoSessionCap - total
	var eligible, limited []store.AutoQuestion
	for _, q := range qs {
		if room <= 0 || recent[q.Identity] >= qaAutoPerAsker {
			limited = append(limited, q)
			continue
		}
		room--
		recent[q.Identity]++
		eligible = append(eligible, q)
	}
	settle(limited, store.AutoLimited)
	if len(eligible) == 0 {
		return 0, nil
	}

	has, err := s.store.SessionHasKnowledge(ctx, slug)
	if err != nil || !has {
		settle(eligible, store.AutoUngrounded)
		return 0, err
	}

	// Contact details never leave for the search, the embedding or the model.
	texts := make([]string, len(eligible))
	for i, q := range eligible {
		texts[i] = knowledge.ScrubPII(q.Text)
	}
	vecs := s.queryVectors(ctx, wb.Host.ID, texts)
	var (
		pool    excerptPool
		items   []aiwrite.AutoAnswerItem
		targets []store.AutoQuestion
		none    []store.AutoQuestion
	)
	for i, q := range eligible {
		hits, err := s.retrieveWith(ctx, slug, texts[i], vecs[i], autoDraftTopChunks, autoDraftTokenBudget)
		if err != nil {
			settle(eligible, store.AutoFailed)
			return 0, err
		}
		if len(hits) == 0 {
			none = append(none, q)
			continue
		}
		it := aiwrite.AutoAnswerItem{Question: texts[i]}
		for _, h := range hits {
			it.Excerpts = append(it.Excerpts, pool.add(h))
		}
		items = append(items, it)
		targets = append(targets, q)
	}
	settle(none, store.AutoUngrounded)
	if len(items) == 0 {
		return 0, nil
	}

	description := wb.Summary
	if d := strings.TrimSpace(wb.Descript); d != "" {
		description = d
	}
	first := ""
	if f := strings.Fields(wb.Host.Name); len(f) > 0 {
		first = f[0]
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureQAAuto, wb.Host.ID, ai.Request{
		Messages:       aiwrite.QAAutoMessages(first, wb.Topic, description, pool.excerpts(), items),
		Schema:         aiwrite.QAAutoSchema,
		MaxTokens:      250*len(items) + 400,
		Temperature:    0.2,
		AttemptTimeout: 20 * time.Second,
	})
	if err != nil {
		settle(targets, store.AutoFailed)
		return 0, err
	}
	answers, err := aiwrite.ParseQAAuto(reply.Text, len(items), len(pool.hits))
	if err != nil {
		settle(targets, store.AutoFailed)
		return 0, err
	}

	label := assistantLabel(wb.Host.Name)
	bg := context.WithoutCancel(ctx)
	var ungrounded []store.AutoQuestion
	var posted []string
	for i, q := range targets {
		a, ok := answers[i]
		if !ok {
			ungrounded = append(ungrounded, q)
			continue
		}
		done, err := s.store.PostAutoAnswer(bg, slug, q.ID, a.Answer, label)
		if err != nil {
			s.log.Warn("qa auto: post", "slug", slug, "question", q.ID, "error", err)
			continue
		}
		if !done {
			continue // the host answered it first
		}
		posted = append(posted, q.ID)
		s.broadcastQMod(bg, wb, map[string]any{
			"kind": "qmod", "questionId": q.ID, "answered": true, "answer": a.Answer, "answerBy": label,
		})
	}
	settle(ungrounded, store.AutoUngrounded)
	if len(posted) > 0 {
		s.announceQAClusters(bg, wb)
	}
	return len(posted), nil
}

// broadcastQMod is one qmod packet to the whole room. Best effort: a reload reads the store.
func (s *Server) broadcastQMod(ctx context.Context, wb types.Webinar, packet map[string]any) {
	if wb.SFUProject == "" {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	if err := s.sendRoomPacket(ctx, sfu, wb.ID, nil, packet); err != nil {
		s.log.Warn("qa auto: packet", "slug", wb.ID, "error", err)
	}
}

/* handleRetractAutoAnswer is POST /api/host/webinars/{slug}/questions/{id}/retract: a host or
 * co-host takes the assistant's answer back. The question is open again, the answer is gone
 * for everyone, and Auto mode does not answer it again. */
func (s *Server) handleRetractAutoAnswer(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	id := chi.URLParam(r, "id")
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "qa auto retract: webinar", err)
		return
	}
	ok, err := s.store.RetractAutoAnswer(r.Context(), slug, id)
	if err != nil {
		s.fail(w, r, "qa auto retract", err)
		return
	}
	if !ok {
		httpx.Error(w, http.StatusNotFound, "not_found", "That question has no assistant answer to retract.")
		return
	}
	bg := context.WithoutCancel(r.Context())
	s.broadcastQMod(bg, wb, map[string]any{
		"kind": "qmod", "questionId": id, "answered": false, "answer": "", "answerBy": "",
	})
	s.announceQAClusters(bg, wb)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "ok"})
}

// ---------------------------------------------------------------- the setting

func (s *Server) autoAnswerView(ctx context.Context, wb types.Webinar) types.SimuliveAutoAnswer {
	return types.SimuliveAutoAnswer{
		Enabled:   wb.Options.SimuliveAutoAnswer,
		Available: s.qaAutoAvailable(ctx, wb.Host.ID),
		Label:     assistantLabel(wb.Host.Name),
	}
}

// handleGetSimuliveAuto is GET /api/host/webinars/{slug}/replay/auto.
func (s *Server) handleGetSimuliveAuto(w http.ResponseWriter, r *http.Request) {
	wb, err := s.store.WebinarBySlug(r.Context(), slugFromContext(r.Context()))
	if err != nil {
		s.fail(w, r, "qa auto setting: webinar", err)
		return
	}
	httpx.JSON(w, http.StatusOK, s.autoAnswerView(r.Context(), wb))
}

/* handlePutSimuliveAuto is PUT /api/host/webinars/{slug}/replay/auto. Switching on needs a
 * simulive and both account features; switching off is always allowed. */
func (s *Server) handlePutSimuliveAuto(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	var body types.SimuliveAutoAnswerRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "qa auto setting: webinar", err)
		return
	}
	if body.Enabled {
		if wb.Kind != types.KindSimulive {
			httpx.Error(w, http.StatusConflict, "not_simulive", "Auto mode is for a simulive session.")
			return
		}
		if !s.qaAutoAvailable(r.Context(), wb.Host.ID) {
			httpx.Error(w, http.StatusForbidden, "feature_off",
				featureLabel(types.FeatureAI)+" and "+featureLabel(types.FeatureReplayEngage)+" both need to be on for this account.")
			return
		}
	}
	if err := s.store.SetSimuliveAutoAnswer(r.Context(), slug, body.Enabled); err != nil {
		s.fail(w, r, "qa auto setting: save", err)
		return
	}
	wb.Options.SimuliveAutoAnswer = body.Enabled
	httpx.JSON(w, http.StatusOK, s.autoAnswerView(r.Context(), wb))
}
