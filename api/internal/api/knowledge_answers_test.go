package api_test

import (
	"archive/zip"
	"bytes"
	"context"
	"hash/fnv"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/knowledge"
	"github.com/netkumar/webcast/api/types"
)

/* Past answers (knowledge_answers.go), Obsidian vault imports (knowledge_vault.go) and hybrid
 * retrieval (knowledge_embed.go), against the fake gpt-5-nano and a fake embedder: no network. */

/* fakeEmbedder makes "semantic" vectors without a model: each searchable word is a dimension
 * of its own, except that the words of a concept share one, so "cost" and "fee" are near
 * each other the way a real embedding puts them. */
type fakeEmbedder struct {
	mu     sync.Mutex
	fail   bool
	calls  int
	inputs []string
}

var fakeConcepts = map[string]int{
	"fee": 1, "fees": 1, "cost": 1, "price": 1, "pay": 1, "paid": 1, "rupees": 1, "charge": 1,
	"refund": 2, "refunds": 2, "money": 2, "back": 2, "return": 2,
	"recording": 3, "recordings": 3, "recorded": 3, "replay": 3,
}

func (f *fakeEmbedder) Enabled() bool { return true }

func (f *fakeEmbedder) Embed(_ context.Context, in []string) (ai.Embedding, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.inputs = append(f.inputs, in...)
	out := ai.Embedding{Provider: "openai", Model: ai.EmbedModel, PromptTokens: 10 * len(in)}
	if f.fail {
		return out, ai.ErrUnavailable
	}
	for _, s := range in {
		v := make([]float32, ai.EmbedDims)
		for _, t := range knowledge.Terms(s) {
			if c, ok := fakeConcepts[t]; ok {
				v[c]++
				continue
			}
			h := fnv.New32a()
			_, _ = h.Write([]byte(t))
			v[100+int(h.Sum32()%1400)]++
		}
		v[0] += 0.01 // never the zero vector
		out.Vectors = append(out.Vectors, v)
	}
	return out, nil
}

func (f *fakeEmbedder) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeEmbedder) setFail(v bool) {
	f.mu.Lock()
	f.fail = v
	f.mu.Unlock()
}

// kbHost signs up a host with the ai feature, named for the test.
func kbHost(t *testing.T, h *harness, tag string) string {
	t.Helper()
	email := "kb2-" + tag + "-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-")) + "@test.dev"
	h.signup("KB Host "+tag, email, true)
	enableAI(t, h, email)
	return email
}

// answerQuestion is the host's "Send answer" in the Q&A panel.
func (h *harness) answerQuestion(slug, id, answer string) {
	h.t.Helper()
	on := true
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+slug+"/questions/"+id, types.QuestionPatch{Answered: &on, Answer: &answer}); res.StatusCode != http.StatusOK {
		h.t.Fatalf("answer %s: %d %s", id, res.StatusCode, raw)
	}
}

func (h *harness) pastAnswers() types.PastAnswers {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/knowledge/answers", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("past answers: %d %s", res.StatusCode, raw)
	}
	var out types.PastAnswers
	h.decode(raw, &out)
	return out
}

func (h *harness) aiUsageCount(feature string) int {
	h.t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), `SELECT count(*)::int FROM ai_usage WHERE feature = $1`, feature).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func TestPastAnswersTypedHarvestIsIdempotentScrubbedAndBackfilled(t *testing.T) {
	h, model := aiHarness(t, "{}", nil)
	ctx := context.Background()
	kbHost(t, h, "typed")
	wb := h.liveWebinar("Money basics", nil)
	h.question(wb.ID, "q-typed-1", "What is the fee? Mail me at asha.k@gmail.com", 3)
	h.question(wb.ID, "q-typed-2", "Is there a weekend batch?", 1)
	h.question(wb.ID, "q-typed-3", "Spam spam", 0)
	h.answerQuestion(wb.ID, "q-typed-1", "It's 499 rupees once. Questions? WhatsApp +91 98765 43210.")
	h.answerQuestion(wb.ID, "q-typed-3", "hidden")
	dismiss := true
	if res, _ := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/questions/q-typed-3", types.QuestionPatch{Dismissed: &dismiss}); res.StatusCode != http.StatusOK {
		t.Fatal("dismiss")
	}
	h.endSession(wb.ID)

	got := h.pastAnswers()
	if len(got.Answers) != 1 || got.Approved != 1 || got.Pending != 0 {
		t.Fatalf("answers = %+v", got)
	}
	a := got.Answers[0]
	if a.Status != types.PastAnswerApproved || a.Origin != types.PastAnswerTyped || a.SourceTopic != "Money basics" || a.SourceAt == "" || a.CanUndo {
		t.Fatalf("entry = %+v", a)
	}
	if a.Question != "What is the fee? Mail me at [email]" || a.Answer != "It's 499 rupees once. Questions? WhatsApp [phone]." {
		t.Fatalf("not scrubbed: %q / %q", a.Question, a.Answer)
	}
	// No attendee name anywhere in the row.
	var row string
	if err := h.store.Pool().QueryRow(ctx, `SELECT row_to_json(a)::text FROM knowledge_answers a WHERE id = $1`, a.ID).Scan(&row); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(row, "Asha") || strings.Contains(row, "att_") || strings.Contains(row, "98765") || strings.Contains(row, "gmail") {
		t.Fatalf("stored row carries personal data: %s", row)
	}
	// No transcript, so no answered-aloud call; no embedder configured, so no embedding call.
	if model.callCount() != 0 || h.aiUsageCount(types.AIFeatureEmbed) != 0 {
		t.Fatalf("calls = %d, embed rows = %d", model.callCount(), h.aiUsageCount(types.AIFeatureEmbed))
	}

	// Idempotent: reading again, or ending again, adds nothing; a deleted entry stays deleted.
	h.goLive(wb.ID)
	h.endSession(wb.ID)
	if got := h.pastAnswers(); len(got.Answers) != 1 {
		t.Fatalf("after a second end: %+v", got.Answers)
	}
	if res, _ := h.do(http.MethodDelete, "/api/host/knowledge/answers/"+a.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatal("delete")
	}
	if got := h.pastAnswers(); len(got.Answers) != 0 {
		t.Fatalf("a deleted entry came back: %+v", got.Answers)
	}

	// Backfill: a session that ended without the hook (before this existed) is harvested on
	// the first read.
	old := h.liveWebinar("Older session", nil)
	h.question(old.ID, "q-old-1", "Do you share the slides?", 0)
	h.answerQuestion(old.ID, "q-old-1", "Yes, slides go out by email after class.")
	if _, err := h.store.SetStatus(ctx, old.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	got = h.pastAnswers()
	if len(got.Answers) != 1 || got.Answers[0].SourceTopic != "Older session" || got.Answers[0].Answer != "Yes, slides go out by email after class." {
		t.Fatalf("backfill = %+v", got.Answers)
	}
	if got := h.pastAnswers(); len(got.Answers) != 1 {
		t.Fatalf("backfill twice: %+v", got.Answers)
	}
}

const harvestReply = `{"answers":[{"question":"h1","answer":"Haan, har class ki recording 24 ghante mein milegi. Doubts ho to 98765 43210 par call karo.","confidence":0.9},{"question":"h2","answer":"The weekend batch starts this Saturday at 10.","confidence":0.9},{"question":"h9","answer":"made up","confidence":0.9}]}`

func TestPastAnswersAloudDraftsArePendingUntilApproved(t *testing.T) {
	h, model := aiHarness(t, "{}", nil)
	ctx := context.Background()
	email := kbHost(t, h, "aloud")
	host, err := h.store.UserByEmail(ctx, email)
	if err != nil {
		t.Fatal(err)
	}
	model.bySchema = map[string]string{"qa_harvest": harvestReply, "session_recap": recapReply}
	wb := h.liveWebinar("Live class Q&A", nil)
	h.question(wb.ID, "q-al-1", "Recording milegi kya?", 5)
	h.question(wb.ID, "q-al-2", "When does the weekend batch start?", 2)
	h.question(wb.ID, "q-al-3", "What is the fee?", 1)
	h.answerQuestion(wb.ID, "q-al-3", "499 rupees.")
	h.caption(wb.ID, "user_"+host.ID, "Recording ka sawaal: haan, har class ki recording 24 ghante mein milegi. Doubts ho to 98765 43210 par call karo.")
	h.caption(wb.ID, "user_"+host.ID, "Weekend batch is Saturday at 10.")
	h.endSession(wb.ID)
	// Before the transcript has settled (the recap is still due), no pass runs.
	if h.pastAnswers(); model.callsFor("qa_harvest") != 0 {
		t.Fatal("harvested before the transcript settled")
	}
	// The Results page's recap poll writes the recap; the next read harvests.
	h.getRecap(wb.ID)
	got := h.pastAnswers()
	if model.callsFor("qa_harvest") != 1 || h.aiUsageCount(types.AIFeatureQAHarvest) != 1 {
		t.Fatalf("harvest calls = %d", model.callsFor("qa_harvest"))
	}
	prompt := userMessage(model.lastBodyFor("qa_harvest"))
	if !strings.Contains(prompt, "h1: Recording milegi kya?") || !strings.Contains(prompt, "h2: When does the weekend batch start?") ||
		strings.Contains(prompt, "What is the fee") || !strings.Contains(prompt, "24 ghante") {
		t.Fatalf("harvest prompt = %s", prompt)
	}
	if got.Pending != 2 || got.Approved != 1 || len(got.Answers) != 3 || got.Answers[0].Status != types.PastAnswerPending {
		t.Fatalf("answers = %+v", got)
	}
	var rec, batch types.PastAnswer
	for _, a := range got.Answers {
		switch a.Question {
		case "Recording milegi kya?":
			rec = a
		case "When does the weekend batch start?":
			batch = a
		}
	}
	if rec.Origin != types.PastAnswerAloud || !strings.Contains(rec.Answer, "[phone]") || strings.Contains(rec.Answer, "98765") {
		t.Fatalf("aloud draft = %+v", rec)
	}

	// Once per session: another read makes no call.
	h.pastAnswers()
	h.getRecap(wb.ID)
	if model.callsFor("qa_harvest") != 1 {
		t.Fatalf("harvested twice: %d", model.callsFor("qa_harvest"))
	}

	// Pending drafts are never retrieved.
	next := h.liveWebinar("Next class", nil)
	search := func(q string) []string {
		t.Helper()
		hits, err := h.store.SearchKnowledge(ctx, next.ID, knowledge.TSQuery(q), 10)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, x := range hits {
			out = append(out, x.Text)
		}
		return out
	}
	if hits := search("recording milegi"); len(hits) != 0 {
		t.Fatalf("a pending draft was retrieved: %v", hits)
	}
	if has, _ := h.store.SessionHasKnowledge(ctx, next.ID); !has {
		t.Fatal("the approved typed answer is knowledge")
	}

	// Approve, edited: approved, the edit kept, and now retrieved.
	edited := "Haan, recording 24 ghante mein milegi, email par."
	res, raw := h.do(http.MethodPost, "/api/host/knowledge/answers/"+rec.ID+"/approve", types.PastAnswerEdit{Answer: edited})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approve: %d %s", res.StatusCode, raw)
	}
	var approved types.PastAnswerResult
	h.decode(raw, &approved)
	if approved.Merged || approved.Answer.Status != types.PastAnswerApproved || approved.Answer.Answer != edited || approved.Answer.Question != rec.Question {
		t.Fatalf("approved = %+v", approved)
	}
	if hits := search("recording milegi"); len(hits) != 1 || !strings.Contains(hits[0], edited) {
		t.Fatalf("approved entry not retrieved: %v", hits)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/knowledge/answers/"+rec.ID+"/approve", nil); res.StatusCode != http.StatusNotFound {
		t.Fatal("approved twice")
	}
	// Skip: the other draft goes, and does not come back.
	if res, _ := h.do(http.MethodDelete, "/api/host/knowledge/answers/"+batch.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatal("skip")
	}
	if got := h.pastAnswers(); got.Pending != 0 || got.Approved != 2 {
		t.Fatalf("after skip: %+v", got)
	}
}

func TestPastAnswersRepeatUpdatesWithUndoAndEditReplaces(t *testing.T) {
	h, _ := aiHarness(t, "{}", nil)
	ctx := context.Background()
	kbHost(t, h, "repeat")
	first := h.liveWebinar("January batch", nil)
	h.question(first.ID, "q-rp-1", "What is the fee?", 0)
	h.answerQuestion(first.ID, "q-rp-1", "It is 399 rupees.")
	h.endSession(first.ID)
	if got := h.pastAnswers(); len(got.Answers) != 1 {
		t.Fatalf("first = %+v", got.Answers)
	}
	second := h.liveWebinar("February batch", nil)
	h.question(second.ID, "q-rp-2", "Fees kitni hai?", 0)
	h.answerQuestion(second.ID, "q-rp-2", "Fee ab 499 rupees hai.")
	h.endSession(second.ID)

	got := h.pastAnswers()
	if len(got.Answers) != 1 {
		t.Fatalf("a repeat was duplicated: %+v", got.Answers)
	}
	a := got.Answers[0]
	if a.Answer != "Fee ab 499 rupees hai." || a.Question != "Fees kitni hai?" || !a.CanUndo || a.UpdatedFrom != "February batch" || a.UpdatedFromAt == "" {
		t.Fatalf("updated = %+v", a)
	}
	res, raw := h.do(http.MethodPost, "/api/host/knowledge/answers/"+a.ID+"/undo", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("undo: %d %s", res.StatusCode, raw)
	}
	var undone types.PastAnswerResult
	h.decode(raw, &undone)
	if undone.Answer.Answer != "It is 399 rupees." || undone.Answer.CanUndo || undone.Answer.SourceTopic != "January batch" {
		t.Fatalf("undone = %+v", undone.Answer)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/knowledge/answers/"+a.ID+"/undo", nil); res.StatusCode != http.StatusNotFound {
		t.Fatal("undo twice")
	}

	// A correction replaces the text: the old words are no longer found.
	if res, raw := h.do(http.MethodPatch, "/api/host/knowledge/answers/"+a.ID, types.PastAnswerEdit{Question: "What is the course fee?", Answer: "From March it is 599 rupees, call 9876543210."}); res.StatusCode != http.StatusOK {
		t.Fatalf("edit: %d %s", res.StatusCode, raw)
	}
	if res, _ := h.do(http.MethodPatch, "/api/host/knowledge/answers/"+a.ID, types.PastAnswerEdit{Question: "x"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatal("an edit with no answer was accepted")
	}
	live := h.liveWebinar("March batch", nil)
	hits, err := h.store.SearchKnowledge(ctx, live.ID, knowledge.TSQuery("399 rupees"), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || !strings.Contains(hits[0].Text, "599") || strings.Contains(hits[0].Text, "399") || strings.Contains(hits[0].Text, "9876543210") || hits[0].Title != "Past answers" {
		t.Fatalf("after edit = %+v", hits)
	}
}

func TestPastAnswersSessionPickAndAccess(t *testing.T) {
	h, _ := aiHarness(t, "{}", nil)
	ctx := context.Background()
	kbHost(t, h, "owner")
	done := h.liveWebinar("Done session", nil)
	h.question(done.ID, "q-ac-1", "Is there a certificate?", 0)
	h.answerQuestion(done.ID, "q-ac-1", "Yes, a certificate after the final quiz.")
	h.endSession(done.ID)
	entry := h.pastAnswers().Answers[0]
	live := h.liveWebinar("Live session", nil)

	// The session card: "Past answers" ticked by default.
	path := "/api/host/webinars/" + live.ID + "/knowledge"
	res, raw := h.do(http.MethodGet, path, nil)
	var sk types.SessionKnowledge
	h.decode(raw, &sk)
	if res.StatusCode != http.StatusOK || !sk.PastAnswers.Included || sk.PastAnswers.Count != 1 {
		t.Fatalf("session knowledge = %d %+v", res.StatusCode, sk)
	}
	find := func() int {
		hits, err := h.store.SearchKnowledge(ctx, live.ID, knowledge.TSQuery("certificate"), 10)
		if err != nil {
			t.Fatal(err)
		}
		return len(hits)
	}
	if find() != 1 {
		t.Fatal("past answer not retrieved")
	}
	res, raw = h.do(http.MethodPatch, path+"/past-answers", types.SessionPastAnswersPatch{Included: false})
	h.decode(raw, &sk)
	if res.StatusCode != http.StatusOK || sk.PastAnswers.Included {
		t.Fatalf("untick = %d %s", res.StatusCode, raw)
	}
	if find() != 0 {
		t.Fatal("past answers left out of the session were retrieved")
	}
	if has, _ := h.store.SessionHasKnowledge(ctx, live.ID); has {
		t.Fatal("a session with past answers off and no documents has knowledge")
	}
	if res, _ := h.do(http.MethodPatch, path+"/past-answers", types.SessionPastAnswersPatch{Included: true}); res.StatusCode != http.StatusOK || find() != 1 {
		t.Fatal("tick again")
	}

	// Another host never sees or touches the entry, nor the session's pick.
	kbHost(t, h, "rival")
	if got := h.pastAnswers(); len(got.Answers) != 0 {
		t.Fatalf("rival sees %+v", got.Answers)
	}
	for _, c := range []struct{ method, path string }{
		{http.MethodPatch, "/api/host/knowledge/answers/" + entry.ID},
		{http.MethodDelete, "/api/host/knowledge/answers/" + entry.ID},
		{http.MethodPost, "/api/host/knowledge/answers/" + entry.ID + "/approve"},
		{http.MethodPost, "/api/host/knowledge/answers/" + entry.ID + "/undo"},
	} {
		if res, raw := h.do(c.method, c.path, types.PastAnswerEdit{Question: "q", Answer: "mine now"}); res.StatusCode != http.StatusNotFound {
			t.Errorf("rival %s %s: %d %s", c.method, c.path, res.StatusCode, raw)
		}
	}
	if res, _ := h.do(http.MethodPatch, path+"/past-answers", types.SessionPastAnswersPatch{Included: false}); res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Fatalf("rival session pick: %d", res.StatusCode)
	}
	// Without the ai feature: not for this account.
	h.signup("No AI", "kb2-noai@test.dev", true)
	if res, raw := h.do(http.MethodGet, "/api/host/knowledge/answers", nil); res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("without ai: %d %s", res.StatusCode, raw)
	}
}

func TestPastAnswersGateOffMeansNoAICalls(t *testing.T) {
	h, model := aiHarness(t, "{}", nil)
	emb := &fakeEmbedder{}
	api.SetEmbedder(h.server, emb)
	ctx := context.Background()
	email := kbHost(t, h, "gate")
	host, _ := h.store.UserByEmail(ctx, email)
	model.bySchema = map[string]string{"qa_harvest": harvestReply}
	wb := h.liveWebinar("AI off session", nil)
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("AI off: %d %s", res.StatusCode, raw)
	}
	h.question(wb.ID, "q-g-1", "Recording milegi kya?", 0)
	h.question(wb.ID, "q-g-2", "What is the fee?", 0)
	h.answerQuestion(wb.ID, "q-g-2", "499 rupees.")
	h.caption(wb.ID, "user_"+host.ID, "Recording 24 ghante mein milegi.")
	h.endSession(wb.ID)
	h.getRecap(wb.ID)
	if got := h.pastAnswers(); len(got.Answers) != 0 {
		t.Fatalf("an AI-off session was harvested: %+v", got.Answers)
	}
	if model.callCount() != 0 || emb.callCount() != 0 {
		t.Fatalf("model calls = %d, embed calls = %d", model.callCount(), emb.callCount())
	}
}

func TestHybridRetrievalFusesAndFallsBackToFullText(t *testing.T) {
	h, _ := aiHarness(t, "{}", nil)
	emb := &fakeEmbedder{}
	api.SetEmbedder(h.server, emb)
	ctx := context.Background()
	kbHost(t, h, "hybrid")
	faq := h.addKnowledge("Course FAQ", courseFAQ)
	h.addKnowledge("Refund policy", refundPolicy)
	var embedded int
	if err := h.store.Pool().QueryRow(ctx, `SELECT count(*)::int FROM knowledge_chunks WHERE embedding IS NOT NULL`).Scan(&embedded); err != nil {
		t.Fatal(err)
	}
	if embedded != 2 || h.aiUsageCount(types.AIFeatureEmbed) != 2 {
		t.Fatalf("embedded on add = %d, usage rows = %d", embedded, h.aiUsageCount(types.AIFeatureEmbed))
	}
	wb := h.liveWebinar("Money basics", nil)
	titles := func(q string) []string {
		t.Helper()
		hits, err := api.RetrieveKnowledge(h.server, ctx, wb, q)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, x := range hits {
			out = append(out, x.Title)
		}
		return out
	}

	// A paraphrase full-text search misses ("cost" is in no document) is found by vector.
	if fts, _ := h.store.SearchKnowledge(ctx, wb.ID, knowledge.TSQuery("How much will it cost me?"), 10); len(fts) != 0 {
		t.Fatalf("full-text found the paraphrase after all: %+v", fts)
	}
	if got := titles("How much will it cost me?"); strings.Join(got, ",") != "Course FAQ" {
		t.Fatalf("paraphrase = %v", got)
	}
	// Fusion: full-text finds only the refund policy ("cost" is in neither); vectors find both.
	// The one in both rankings comes first, and the vector-only one is still in.
	if fts, _ := h.store.SearchKnowledge(ctx, wb.ID, knowledge.TSQuery("refund cost"), 10); len(fts) != 1 || fts[0].Title != "Refund policy" {
		t.Fatalf("full-text = %+v", fts)
	}
	if got := titles("refund cost"); strings.Join(got, ",") != "Refund policy,Course FAQ" {
		t.Fatalf("fused = %v", got)
	}

	// The embedder fails: full-text alone, silently.
	emb.setFail(true)
	if got := titles("How much will it cost me?"); len(got) != 0 {
		t.Fatalf("no embedder, paraphrase = %v", got)
	}
	if got := titles("Is a refund possible?"); strings.Join(got, ",") != "Refund policy" {
		t.Fatalf("no embedder, full text = %v", got)
	}
	// What is added meanwhile is backfilled on the library's next read.
	h.addKnowledge("Batches", "Weekend batch on Saturday mornings; the recording is shared the same day.")
	var missing int
	_ = h.store.Pool().QueryRow(ctx, `SELECT count(*)::int FROM knowledge_chunks WHERE embedding IS NULL`).Scan(&missing)
	if missing != 1 {
		t.Fatalf("chunks without embedding = %d", missing)
	}
	emb.setFail(false)
	if res, _ := h.do(http.MethodGet, "/api/host/knowledge", nil); res.StatusCode != http.StatusOK {
		t.Fatal("library")
	}
	_ = h.store.Pool().QueryRow(ctx, `SELECT count(*)::int FROM knowledge_chunks WHERE embedding IS NULL`).Scan(&missing)
	if missing != 0 {
		t.Fatalf("not backfilled: %d", missing)
	}
	if got := strings.Join(titles("Is there a replay?"), ","); !strings.Contains(got, "Batches") {
		t.Fatalf("replay = %v", got)
	}
	_ = faq

	// Repeats by embedding: the same question in other words updates the entry.
	h.endLive(wb.ID) // one live session per host
	first := h.liveWebinar("Session one", nil)
	h.question(first.ID, "q-hy-1", "What is the price?", 0)
	h.answerQuestion(first.ID, "q-hy-1", "499 rupees.")
	h.endSession(first.ID)
	second := h.liveWebinar("Session two", nil)
	h.question(second.ID, "q-hy-2", "How much does it cost?", 0)
	h.answerQuestion(second.ID, "q-hy-2", "Now 599 rupees.")
	h.endSession(second.ID)
	got := h.pastAnswers()
	if len(got.Answers) != 1 || got.Answers[0].Answer != "Now 599 rupees." || got.Answers[0].UpdatedFrom != "Session two" {
		t.Fatalf("vector repeat = %+v", got.Answers)
	}
}

func vaultZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func (h *harness) importVault(filename string, body []byte) (*http.Response, []byte) {
	h.t.Helper()
	return h.doRaw(http.MethodPost, "/api/host/knowledge/vault?"+url.Values{"filename": {filename}}.Encode(), "application/zip", body, nil)
}

func TestObsidianVaultImport(t *testing.T) {
	h, _ := aiHarness(t, "{}", nil)
	kbHost(t, h, "vault")
	data := vaultZip(t, map[string]string{
		"Coach/.obsidian/app.json":      `{"x":1}`,
		"Coach/.obsidian/snippets/a.md": "# hidden",
		"Coach/assets/logo.png":         "png",
		"Coach/Programs/Fees.md":        "---\ntags: [money]\n---\n# Programme fees\nThe fee is 499 rupees; see [[Refunds|the refund rules]].\n![[logo.png]]",
		"Coach/Refunds.md":              "Full refund within 7 days. Linked from [[Programs/Fees]].",
		"Coach/Programs/Empty.md":       "---\na: b\n---\n",
	})
	res, raw := h.importVault("Coach vault.zip", data)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("import: %d %s", res.StatusCode, raw)
	}
	var out types.KnowledgeVaultImport
	h.decode(raw, &out)
	if len(out.Docs) != 2 || out.Skipped != 4 {
		t.Fatalf("import = %+v", out)
	}
	by := map[string]types.KnowledgeDoc{}
	for _, d := range out.Docs {
		by[d.Title] = d
	}
	fees, refunds := by["Programme fees"], by["Refunds"]
	if fees.Folder != "Programs" || fees.Source != knowledge.SourceMD || refunds.Folder != "" {
		t.Fatalf("docs = %+v", out.Docs)
	}
	_, raw = h.do(http.MethodGet, "/api/host/knowledge/"+fees.ID, nil)
	var detail types.KnowledgeDocDetail
	h.decode(raw, &detail)
	if detail.Text != "The fee is 499 rupees; see the refund rules." || detail.Doc.Folder != "Programs" {
		t.Fatalf("fees text = %q", detail.Text)
	}
	_, raw = h.do(http.MethodGet, "/api/host/knowledge/"+refunds.ID, nil)
	h.decode(raw, &detail)
	if detail.Text != "Full refund within 7 days. Linked from Fees." {
		t.Fatalf("refunds text = %q", detail.Text)
	}

	// Refusals: not a zip by name or by content, a bomb, no notes, and a vault over the caps.
	big := strings.Repeat("a", knowledge.VaultMaxFileBytes+1)
	for _, c := range []struct {
		name, file string
		body       []byte
		status     int
		code       string
	}{
		{"not zip name", "vault.rar", data, http.StatusUnsupportedMediaType, "unsupported"},
		{"not zip body", "vault.zip", []byte("hello"), http.StatusUnprocessableEntity, "unreadable"},
		{"bomb", "vault.zip", vaultZip(t, map[string]string{"big.md": big}), http.StatusUnprocessableEntity, "note_too_large"},
		{"no notes", "vault.zip", vaultZip(t, map[string]string{".obsidian/a.json": "{}", "x.png": "p"}), http.StatusUnprocessableEntity, "no_notes"},
	} {
		if res, raw := h.importVault(c.file, c.body); res.StatusCode != c.status || errorCode(t, raw) != c.code {
			t.Errorf("%s: %d %s", c.name, res.StatusCode, raw)
		}
	}
	many := map[string]string{}
	for i := 0; i < types.KnowledgeMaxDocs-1; i++ {
		many["Notes/n"+strings.Repeat("x", i+1)+".md"] = "note text"
	}
	res, raw = h.importVault("many.zip", vaultZip(t, many))
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "library_full" || !strings.Contains(string(raw), "room for 48 more documents") {
		t.Fatalf("over the caps: %d %s", res.StatusCode, raw)
	}
	_, raw = h.do(http.MethodGet, "/api/host/knowledge", nil)
	var lib types.KnowledgeLibrary
	h.decode(raw, &lib)
	if len(lib.Docs) != 2 {
		t.Fatalf("a refused vault was half imported: %d docs", len(lib.Docs))
	}
}

// At the host's monthly AI cap no embedding is asked for: documents are still added and
// found by full-text search.
func TestEmbeddingsRespectTheCap(t *testing.T) {
	h, _ := aiHarness(t, "hi", func(c *config.Config) { c.AIHostMonthlyUSD = 0.01 })
	emb := &fakeEmbedder{}
	api.SetEmbedder(h.server, emb)
	ctx := context.Background()
	email := kbHost(t, h, "cap")
	host, _ := h.store.UserByEmail(ctx, email)
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureWebinarSetup, host.ID, aiHello); err != nil {
		t.Fatal(err) // $0.045: past the cap
	}
	h.addKnowledge("Refund policy", refundPolicy)
	wb := h.liveWebinar("Capped", nil)
	hits, err := api.RetrieveKnowledge(h.server, ctx, wb, "Is a refund possible?")
	if err != nil || len(hits) != 1 {
		t.Fatalf("hits = %+v, err = %v", hits, err)
	}
	if emb.callCount() != 0 {
		t.Fatalf("embedder called %d times past the cap", emb.callCount())
	}
}
