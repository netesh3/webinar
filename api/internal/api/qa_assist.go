package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/aiwrite"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The live Q&A assistant: for the host and co-hosts only. The audience's Q&A is untouched.
 *
 *   merge     questions that ask the same thing are grouped into a cluster with a short
 *             canonical wording (session_qa_clusters, migration 0132), so the host's panel
 *             shows "3 people asked this" once instead of three cards.
 *   rank      a "Top questions" strip: clusters by upvotes, askers and recency, counted here
 *             (rankQAClusters), never by a model.
 *   suggest   on the host's click, one call drafts a short answer from the session's topic and
 *             the last few minutes of transcript. Returned to that host only; never posted,
 *             never stored.
 *
 * All of it only while sessionAIAllowed (the account's ai feature AND the room's AI switch);
 * otherwise GET /qa/clusters says enabled:false and the panel is the plain list it always was.
 *
 * When a grouping pass runs. Not on every question: a busy room asks one a second. A pass is
 * due when qaClusterBatch questions are waiting, or the oldest waiting one is qaClusterEvery
 * old (qaClusterDue). The check runs when a question is asked (off the request path), on a
 * timer armed for the oldest one's deadline, and when a host's panel reads the clusters — that
 * last one inline, because on Cloud Run a request is what has the CPU. One pass in flight per
 * session: in this process (qaSession.running) and across instances (a lease). The input is
 * bounded: the newest qaClusterWindow open questions.
 *
 * Every pass first groups by normalised text (qaNormalize) for free; only what is left goes to
 * the model, and not at all when there is nothing it could be merged with. At an AI cap the
 * pass stops (session_qa_state.limited_at), the panel says "AI limit reached", and the trigger
 * leaves the cap alone for qaLimitedPause.
 */

var (
	// qaClusterEvery is the longest a question waits for a pass. A var for tests.
	qaClusterEvery = 20 * time.Second
	// qaClusterSync runs a question's check on the request path instead of beside it, for tests.
	qaClusterSync = false
)

const (
	// qaClusterBatch questions waiting make a pass due at once.
	qaClusterBatch = 3
	// qaClusterWindow bounds a pass: the newest this many open questions.
	qaClusterWindow = 100
	// qaClusterListLimit bounds the host's read; it matches roomQuestionLimit.
	qaClusterListLimit = 300
	// qaClusterLease outlives one pass.
	qaClusterLease = 60 * time.Second
	// qaClusterTimeout bounds one pass.
	qaClusterTimeout = 25 * time.Second
	// qaLimitedPause is how long a cap stops passes before one tries again.
	qaLimitedPause = 10 * time.Minute
	// qaFailBackoff is how long after a pass no provider answered the next may run.
	qaFailBackoff = time.Minute
	// qaTopN is the length of the Top questions strip.
	qaTopN = 3
	// qaAnswerTranscript is how far back a suggested answer reads the captions.
	qaAnswerTranscript = 5 * time.Minute
	// qaProvisional prefixes the id of a question no pass has grouped yet.
	qaProvisional = "q_"
)

// qaClustersChangedKind tells the host and co-hosts to re-read the clusters. Server-only, and
// addressed to them alone: the audience never sees a cluster.
const qaClustersChangedKind = "qa-clusters"

// qaSession is one session's pass state in this process.
type qaSession struct {
	mu      sync.Mutex
	running bool
	timer   *time.Timer
	retryAt time.Time
}

func (s *Server) qaSession(slug string) *qaSession {
	v, _ := s.qaSessions.LoadOrStore(slug, &qaSession{})
	return v.(*qaSession)
}

// qaClusterDue is the batching rule: enough questions waiting, or one waiting long enough.
func qaClusterDue(pending int, oldest, now time.Time) bool {
	if pending <= 0 {
		return false
	}
	return pending >= qaClusterBatch || now.Sub(oldest) >= qaClusterEvery
}

/* qaQuestionAsked is handleSay's hook for a new question: the check, off the request path, so
 * an attendee's question is never held up by the assistant. */
func (s *Server) qaQuestionAsked(ctx context.Context, wb types.Webinar) {
	if !wb.Controls.AIEnabled || !s.ai.Enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), qaClusterTimeout+5*time.Second)
	if qaClusterSync {
		defer cancel()
		s.qaMaybeCluster(ctx, wb)
		return
	}
	go func() { // #nosec G118 -- runs beside the request on purpose; bounded by the timeout above
		defer cancel()
		s.qaMaybeCluster(ctx, wb)
	}()
}

/* qaMaybeCluster runs a pass if one is due, and otherwise arms the timer for when the oldest
 * waiting question will make one due. Reports whether a pass changed anything. */
func (s *Server) qaMaybeCluster(ctx context.Context, wb types.Webinar) bool {
	if wb.Status != types.StatusLive || !s.ai.Enabled() || !s.sessionAIAllowed(ctx, wb) {
		return false
	}
	slug := wb.ID
	now := time.Now()
	st := s.qaSession(slug)
	st.mu.Lock()
	busy, backoff := st.running, now.Before(st.retryAt)
	st.mu.Unlock()
	if busy || backoff {
		return false
	}
	if at, err := s.store.QALimitedAt(ctx, slug); err == nil && !at.IsZero() && now.Sub(at) < qaLimitedPause {
		return false
	}
	pending, oldest, err := s.store.QAPending(ctx, slug, qaClusterWindow)
	if err != nil {
		s.log.Warn("qa assist: pending", "slug", slug, "error", err)
		return false
	}
	if pending == 0 {
		return false
	}
	if !qaClusterDue(pending, oldest, now) {
		s.qaArm(slug, oldest.Add(qaClusterEvery).Sub(now))
		return false
	}
	changed, err := s.runQAPass(ctx, wb)
	if err != nil && !errors.Is(err, errAILimit) {
		s.log.Warn("qa assist: pass", "slug", slug, "error", err)
	}
	return changed
}

// qaArm sets the session's timer to check again after d, unless one is already set.
func (s *Server) qaArm(slug string, d time.Duration) {
	st := s.qaSession(slug)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.timer != nil {
		return
	}
	if d < time.Second {
		d = time.Second
	}
	st.timer = time.AfterFunc(d, func() {
		st.mu.Lock()
		st.timer = nil
		st.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), qaClusterTimeout+5*time.Second)
		defer cancel()
		wb, err := s.store.WebinarBySlug(ctx, slug)
		if err != nil {
			return
		}
		s.qaMaybeCluster(ctx, wb)
	})
}

/* runQAPass is one grouping pass. Reports whether any question was placed. errAILimit when a
 * cap stopped it (what the free pre-pass grouped is still saved). */
func (s *Server) runQAPass(ctx context.Context, wb types.Webinar) (bool, error) {
	slug := wb.ID
	st := s.qaSession(slug)
	st.mu.Lock()
	if st.running {
		st.mu.Unlock()
		return false, nil
	}
	st.running = true
	st.mu.Unlock()
	defer func() {
		st.mu.Lock()
		st.running = false
		st.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(ctx, qaClusterTimeout)
	defer cancel()
	release, ok, err := s.store.TryLease(ctx, "qa_cluster:"+slug, qaClusterLease)
	if err != nil || !ok {
		return false, err
	}
	defer release()

	qs, err := s.store.QAQuestions(ctx, slug, true, qaClusterWindow)
	if err != nil {
		return false, err
	}
	plan := planQAClusters(qs)
	var passErr error
	switch {
	case len(plan.groups) == 0:
	case len(plan.groups) == 1 && len(plan.existing) == 0:
		// Nothing it could be merged with: no call.
		plan.newCluster(plan.groups[0], "")
	default:
		passErr = s.qaClusterWithAI(ctx, wb, &plan)
	}
	bg := context.WithoutCancel(ctx)
	if len(plan.assign) > 0 {
		if err := s.store.SaveQAClusters(bg, slug, plan.created, plan.assign); err != nil {
			return false, err
		}
	}
	announce := len(plan.assign) > 0
	switch {
	case errors.Is(passErr, errAILimit):
		now := time.Now()
		_ = s.store.SetQALimited(bg, slug, &now)
		// The panels' "AI limit reached" note.
		announce = true
	case passErr != nil:
		st.mu.Lock()
		st.retryAt = time.Now().Add(qaFailBackoff)
		st.mu.Unlock()
	default:
		if at, err := s.store.QALimitedAt(bg, slug); err == nil && !at.IsZero() {
			_ = s.store.SetQALimited(bg, slug, nil)
		}
	}
	if announce {
		s.announceQAClusters(bg, wb)
	}
	return len(plan.assign) > 0, passErr
}

// qaClusterWithAI places the plan's remaining groups with one model call.
func (s *Server) qaClusterWithAI(ctx context.Context, wb types.Webinar, plan *qaPlan) error {
	existing := make([]aiwrite.QAExisting, len(plan.existing))
	for i, e := range plan.existing {
		existing[i] = aiwrite.QAExisting{Canonical: e.canonical}
	}
	fresh := make([]string, len(plan.groups))
	for i, g := range plan.groups {
		fresh[i] = g.text
	}
	reply, err := s.aiComplete(ctx, types.AIFeatureQACluster, wb.Host.ID, ai.Request{
		Messages:       aiwrite.QAClusterMessages(wb.Topic, existing, fresh),
		Schema:         aiwrite.QAClusterSchema,
		MaxTokens:      2500,
		Temperature:    0.1,
		AttemptTimeout: 15 * time.Second,
	})
	if err != nil {
		return err
	}
	groups, err := aiwrite.ParseQAClusters(reply.Text, len(plan.existing), len(plan.groups))
	if err != nil {
		return err
	}
	for _, g := range groups {
		if g.Existing >= 0 {
			cid := plan.existing[g.Existing].id
			for _, i := range g.Questions {
				plan.join(plan.groups[i], cid)
			}
			continue
		}
		members := plan.groups[g.Questions[0]]
		for _, i := range g.Questions[1:] {
			members.ids = append(members.ids, plan.groups[i].ids...)
		}
		plan.newCluster(members, g.Canonical)
	}
	return nil
}

// ---------------------------------------------------------------- the free pre-pass

// qaNormalize is a question as the pre-pass compares it: lower case, letters and digits only,
// single spaces. "What's the fee??" and "whats the fee" are the same question.
func qaNormalize(s string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r == '\'' || r == '’':
			// "what's" is "whats", not "what s".
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r):
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(r)
		default:
			space = true
		}
	}
	return b.String()
}

type qaGroup struct {
	text string
	ids  []string
}

type qaExisting struct {
	id, canonical string
}

// qaPlan is one pass's work: what is already grouped, what the pre-pass placed, and the
// groups left for the model.
type qaPlan struct {
	existing []qaExisting
	groups   []qaGroup
	created  []store.QANewCluster
	assign   map[string]string
}

func (p *qaPlan) join(g qaGroup, clusterID string) {
	for _, id := range g.ids {
		p.assign[id] = clusterID
	}
}

func (p *qaPlan) newCluster(g qaGroup, canonical string) {
	canonical = strings.TrimSpace(canonical)
	if canonical == "" {
		canonical = clipRunes(strings.Join(strings.Fields(g.text), " "), aiwrite.MaxCanonicalRunes)
	}
	id := newQAClusterID()
	p.created = append(p.created, store.QANewCluster{ID: id, Canonical: canonical})
	p.join(g, id)
}

/* planQAClusters is the deterministic pre-pass over the open questions (oldest first): a new
 * question whose normalised text matches a grouped question, or a cluster's wording, joins that
 * cluster; new questions with the same normalised text form one group. Whatever is left is
 * plan.groups, for the model. */
func planQAClusters(qs []store.QAQuestion) qaPlan {
	plan := qaPlan{assign: map[string]string{}}
	byText := map[string]string{}
	seen := map[string]bool{}
	for _, q := range qs {
		if q.ClusterID == "" {
			continue
		}
		if !seen[q.ClusterID] {
			seen[q.ClusterID] = true
			plan.existing = append(plan.existing, qaExisting{id: q.ClusterID, canonical: q.Canonical})
			if n := qaNormalize(q.Canonical); n != "" {
				byText[n] = q.ClusterID
			}
		}
		if n := qaNormalize(q.Text); n != "" {
			byText[n] = q.ClusterID
		}
	}
	index := map[string]int{}
	for _, q := range qs {
		if q.ClusterID != "" {
			continue
		}
		n := qaNormalize(q.Text)
		if cid, ok := byText[n]; ok && n != "" {
			plan.assign[q.ID] = cid
			continue
		}
		if i, ok := index[n]; ok && n != "" {
			plan.groups[i].ids = append(plan.groups[i].ids, q.ID)
			continue
		}
		index[n] = len(plan.groups)
		plan.groups = append(plan.groups, qaGroup{text: q.Text, ids: []string{q.ID}})
	}
	return plan
}

func newQAClusterID() string {
	var b [10]byte
	_, _ = rand.Read(b[:])
	return "qc_" + hex.EncodeToString(b[:])
}

// ---------------------------------------------------------------- ranking

/* buildQAClusters turns the session's questions into the clusters the panel shows, with a
 * question no pass has reached as a provisional cluster of its own. Ordered oldest first by
 * their first question, which is the order the plain list uses. */
func buildQAClusters(qs []store.QAQuestion, now time.Time) []types.QACluster {
	type acc struct {
		c      types.QACluster
		askers map[string]bool
		latest time.Time
	}
	order := []string{}
	all := map[string]*acc{}
	for _, q := range qs {
		id, canonical, provisional := q.ClusterID, q.Canonical, false
		if id == "" {
			id, canonical, provisional = qaProvisional+q.ID, q.Text, true
		}
		a, ok := all[id]
		if !ok {
			a = &acc{c: types.QACluster{ID: id, Canonical: canonical, QuestionIDs: []string{}, Provisional: provisional},
				askers: map[string]bool{}}
			all[id] = a
			order = append(order, id)
		}
		a.c.QuestionIDs = append(a.c.QuestionIDs, q.ID)
		a.c.Upvotes += q.Upvotes
		asker := q.Identity
		if asker == "" {
			asker = "?" + q.ID
		}
		a.askers[asker] = true
		if !q.Answered && !q.Dismissed {
			a.c.Open++
		}
		if q.CreatedAt.After(a.latest) {
			a.latest = q.CreatedAt
		}
	}
	out := make([]types.QACluster, 0, len(order))
	for _, id := range order {
		a := all[id]
		a.c.Askers = len(a.askers)
		a.c.LatestAt = a.latest.UTC().Format(time.RFC3339)
		a.c.Score = qaScore(a.c.Upvotes, a.c.Askers, now.Sub(a.latest))
		out = append(out, a.c)
	}
	return out
}

/* qaScore ranks a cluster: an upvote is a point, another person asking it is two (asking costs
 * more than clicking), and a recent question gets up to five more, halving every five minutes,
 * so the strip follows the conversation instead of freezing on the first popular question. */
func qaScore(upvotes, askers int, age time.Duration) float64 {
	if age < 0 {
		age = 0
	}
	recency := 5 * math.Pow(0.5, age.Minutes()/5)
	return math.Round((float64(upvotes)+2*float64(askers)+recency)*100) / 100
}

// rankQAClusters is the Top questions strip: the open clusters, best first, at most n; none
// with fewer than two open clusters, where a "top" would only repeat the list.
func rankQAClusters(cs []types.QACluster, n int) []string {
	open := make([]types.QACluster, 0, len(cs))
	for _, c := range cs {
		if c.Open > 0 {
			open = append(open, c)
		}
	}
	if len(open) < 2 {
		return []string{}
	}
	sort.SliceStable(open, func(i, j int) bool {
		if open[i].Score != open[j].Score {
			return open[i].Score > open[j].Score
		}
		return open[i].LatestAt > open[j].LatestAt
	})
	out := []string{}
	for i := 0; i < len(open) && i < n; i++ {
		out = append(out, open[i].ID)
	}
	return out
}

// ---------------------------------------------------------------- realtime

// hostTeam is who a host-only packet goes to: the host, and any co-host in the room.
func (s *Server) hostTeam(ctx context.Context, sfu RoomManager, wb types.Webinar) []string {
	to := []string{hostIdentity(wb.Host.ID)}
	if parts, err := sfu.Participants(ctx, lk.RoomName(wb.ID)); err == nil {
		for _, p := range parts {
			if p.CoHost && p.Identity != to[0] {
				to = append(to, p.Identity)
			}
		}
	}
	return to
}

// announceQAClusters tells the host team to re-read the clusters. Best effort: their panels
// poll as well.
func (s *Server) announceQAClusters(ctx context.Context, wb types.Webinar) {
	if wb.SFUProject == "" {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	if err := s.sendRoomPacket(ctx, sfu, wb.ID, s.hostTeam(ctx, sfu, wb), map[string]any{
		"kind": qaClustersChangedKind,
		"at":   time.Now().UnixMilli(),
	}); err != nil {
		s.log.Warn("qa assist: announce", "slug", wb.ID, "error", err)
	}
}

// ---------------------------------------------------------------- handlers

// handleQAClusters is GET /api/host/webinars/{slug}/qa/clusters.
func (s *Server) handleQAClusters(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "qa clusters: webinar", err)
		return
	}
	out := types.QAClustersResponse{Clusters: []types.QACluster{}, Top: []string{}}
	if !s.ai.Enabled() || !s.sessionAIAllowed(r.Context(), wb) {
		httpx.JSON(w, http.StatusOK, out)
		return
	}
	out.Enabled = true
	// The panel's read is also a trigger: on Cloud Run, a request is what has the CPU.
	s.qaMaybeCluster(r.Context(), wb)

	qs, err := s.store.QAQuestions(r.Context(), slug, false, qaClusterListLimit)
	if err != nil {
		s.fail(w, r, "qa clusters: questions", err)
		return
	}
	out.Clusters = buildQAClusters(qs, time.Now())
	out.Top = rankQAClusters(out.Clusters, qaTopN)
	if at, err := s.store.QALimitedAt(r.Context(), slug); err == nil && !at.IsZero() {
		out.Limited = true
	}
	httpx.JSON(w, http.StatusOK, out)
}

// handleQASuggest is POST /api/host/webinars/{slug}/qa/clusters/{id}/suggest: one call, a
// private draft for the host who asked. Nothing is posted or stored.
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
		MaxTokens:      400,
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
	answer := aiwrite.CleanQAAnswer(reply.Text)
	if answer == "" {
		httpx.Error(w, http.StatusServiceUnavailable, "ai_unavailable",
			"Suggested answers aren't available right now. Try again in a minute.")
		return
	}
	httpx.JSON(w, http.StatusOK, types.QASuggestResponse{Answer: answer})
}
