package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/types"
)

/* A simulive's Auto mode (qa_auto.go), against the fake gpt-5-nano: grounded answers posted
 * signed as the assistant (never the host), anything else left open; off by default, behind
 * both features and the room's AI switch; one call for a batch; capped per session and per
 * asker; retractable; Q&A only. */

const assistant = "✨ Asha's assistant"

type autoFixture struct {
	h      *harness
	model  *fakeOpenAI
	hostID string
	sim    types.Webinar
	guests []types.Registration
}

func (f autoFixture) feature(key string, on bool) {
	f.h.t.Helper()
	if _, err := f.h.store.SetFeatureOverride(context.Background(), f.hostID, key, &on); err != nil {
		f.h.t.Fatal(err)
	}
}

// newAutoFixture is a live simulive of "Asha Rao", with both features and Auto mode as `auto`,
// the course FAQ in her knowledge, and three guests.
func newAutoFixture(t *testing.T, auto bool) autoFixture {
	t.Helper()
	t.Cleanup(api.SetQAAuto(time.Millisecond, 50))
	h, model := aiHarness(t, `{"answers":[]}`, nil)
	email := "auto-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-")) + "@test.dev"
	acct := h.signup("Asha Rao", email, true)
	f := autoFixture{h: h, model: model, hostID: acct.ID}
	f.feature(types.FeatureAI, true)
	f.feature(types.FeatureReplayEngage, true)
	h.addKnowledge("Course FAQ", courseFAQ)

	orig := h.liveWebinar("Money basics, the original", nil)
	var recID string
	if err := h.store.Pool().QueryRow(context.Background(), `
		INSERT INTO recordings (webinar_id, status, mime, storage_key, size_bytes, duration_ms, created_at, stopped_at)
		SELECT id, 'ready', 'video/mp4', 'aa/bb/auto.mp4', 1000, 600000, now() - interval '1 hour', now() - interval '50 minutes'
		  FROM webinars WHERE slug = $1 RETURNING id::text`, orig.ID).Scan(&recID); err != nil {
		t.Fatal(err)
	}
	f.sim = h.liveWebinar("Money basics for your first salary", func(in *types.WebinarInput) {
		in.Kind = types.KindSimulive
		in.SimuliveRecordingID = recID
		in.Options.SimuliveAutoAnswer = auto
	})
	for _, g := range []string{"asha", "ravi", "meera"} {
		f.guests = append(f.guests, h.registerAsGuest(f.sim.ID, "auto-"+g+"-"+strings.ToLower(t.Name())+"@test.dev"))
	}
	return f
}

// ask is one guest's question, and how long Auto mode told their browser to wait.
func (f autoFixture) ask(g types.Registration, id, text string) int {
	f.h.t.Helper()
	res, raw := f.h.sayAsGuest(f.sim.ID, types.SendMessageRequest{JoinKey: g.JoinKey, Kind: types.MsgQuestion, ID: id, Text: text})
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("ask: %d %s", res.StatusCode, raw)
	}
	var out types.SendMessageResponse
	f.h.decode(raw, &out)
	return out.AutoAnswerInMs
}

// tick is the asker's browser coming back for the batch.
func (f autoFixture) tick(g types.Registration) int {
	f.h.t.Helper()
	body, _ := json.Marshal(types.QAAutoRequest{JoinKey: g.JoinKey})
	res, err := (&http.Client{}).Post(f.h.srv.URL+"/api/webinars/"+f.sim.ID+"/qa/auto", "application/json", bytes.NewReader(body))
	if err != nil {
		f.h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("qa auto: %d %s", res.StatusCode, raw)
	}
	var out types.QAAutoResponse
	f.h.decode(raw, &out)
	return out.Answered
}

func (f autoFixture) question(id string) types.SessionQuestion {
	f.h.t.Helper()
	q, ok := findQuestion(f.h.questionsAsGuest(f.sim.ID, f.guests[2].JoinKey), id)
	if !ok {
		f.h.t.Fatalf("question %s not in the room", id)
	}
	return q
}

// qmods is every qmod packet handed to the SFU.
func (f autoFixture) qmods() []map[string]any {
	f.h.rooms.mu.Lock()
	defer f.h.rooms.mu.Unlock()
	var out []map[string]any
	for _, p := range f.h.rooms.sent {
		var m map[string]any
		if json.Unmarshal(p.data, &m) == nil && m["kind"] == "qmod" {
			out = append(out, m)
		}
	}
	return out
}

func TestQAAutoAnswersGroundedQuestionsAsTheAssistant(t *testing.T) {
	f := newAutoFixture(t, true)
	h, g := f.h, f.guests
	f.model.bySchema = map[string]string{"qa_auto": `{"answers":[
		{"question":"n1","answer":"The Money Basics course fee is 499 rupees, paid once.","grounded":true,"sources":["k1"]},
		{"question":"n2","answer":"Probably yes, ask the coach.","grounded":false,"sources":[]}]}`}

	// Three questions arrive together; the certificate one has nothing in the knowledge.
	if ms := f.ask(g[0], "q-fee-0001", "What is the fee? Mail me at ravi.k@example.com"); ms <= 0 {
		t.Fatalf("autoAnswerInMs = %d, want the browser told to come back", ms)
	}
	f.ask(g[1], "q-rec-0001", "Is every live class recorded?")
	f.ask(g[2], "q-cert-001", "Do we get a certificate?")
	// Chat is never auto-answered, and makes no call.
	h.mustSayAsGuest(f.sim.ID, types.SendMessageRequest{JoinKey: g[0].JoinKey, Kind: types.MsgChat, ID: "chat-fee-0001", Text: "What is the fee?"})
	if n := f.model.callCount(); n != 0 {
		t.Fatalf("calls before the batch = %d", n)
	}

	// One request answers the batch: ONE call, for the two questions with knowledge hits.
	if n := f.tick(g[0]); n != 1 {
		t.Fatalf("answered = %d, want 1", n)
	}
	if n := f.model.callsFor("qa_auto"); n != 1 || f.model.callCount() != 1 {
		t.Fatalf("calls = %d (qa_auto %d), want one batched call", f.model.callCount(), n)
	}
	p := f.model.userPrompt(0)
	if !strings.Contains(p, "n1: What is the fee?") || !strings.Contains(p, "n2: Is every live class recorded?") ||
		strings.Contains(p, "certificate") || strings.Contains(p, "n3:") {
		t.Fatalf("prompt = %s", p)
	}
	if strings.Contains(p, "example.com") || !strings.Contains(p, "[email]") {
		t.Fatalf("PII reached the model: %s", p)
	}
	sys, _ := f.model.bodies[0]["messages"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(sys, "Asha's assistant") || !strings.Contains(sys, "Never claim to be Asha") {
		t.Fatalf("system prompt = %s", sys)
	}

	// Grounded: posted, signed by the assistant, never the host.
	fee := f.question("q-fee-0001")
	if !fee.Answered || fee.AnswerBy != assistant || fee.Answer != "The Money Basics course fee is 499 rupees, paid once." {
		t.Fatalf("fee question = %+v", fee)
	}
	// Not grounded, and no hits: open, nothing for the audience.
	for _, id := range []string{"q-rec-0001", "q-cert-001"} {
		if q := f.question(id); q.Answered || q.Answer != "" || q.AnswerBy != "" {
			t.Fatalf("%s should stay open: %+v", id, q)
		}
	}
	mods := f.qmods()
	if len(mods) != 1 || mods[0]["questionId"] != "q-fee-0001" || mods[0]["answerBy"] != assistant || mods[0]["answered"] != true {
		t.Fatalf("qmod packets = %+v", mods)
	}
	if strings.Contains(mods[0]["answerBy"].(string), "Rao") {
		t.Fatal("the assistant is signed with the host's full name")
	}
	found := false
	for _, u := range h.adminAI().Month.Features {
		found = found || (u.Feature == types.AIFeatureQAAuto && u.Calls == 1)
	}
	if !found {
		t.Fatal("ai usage has no qa_auto call")
	}

	// Nothing left waiting: a second request makes no call.
	h.login("auto-" + strings.ToLower(t.Name()) + "@test.dev")
	if n := f.tick(g[1]); n != 0 || f.model.callCount() != 1 {
		t.Fatalf("second tick: answered %d, calls %d", n, f.model.callCount())
	}

	// The host retracts it: open again for everyone, and never answered automatically again.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/questions/q-fee-0001/retract", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("retract: %d %s", res.StatusCode, raw)
	}
	if q := f.question("q-fee-0001"); q.Answered || q.Answer != "" || q.AnswerBy != "" {
		t.Fatalf("retracted = %+v", q)
	}
	mods = f.qmods()
	if last := mods[len(mods)-1]; last["answered"] != false || last["answer"] != "" || last["answerBy"] != "" {
		t.Fatalf("retract packet = %+v", last)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/questions/q-fee-0001/retract", nil)
	h.wantError(res, raw, http.StatusNotFound, "not_found")
	if f.tick(g[0]); f.model.callCount() != 1 {
		t.Fatal("a retracted question was answered again")
	}
	// A host's answer is never retracted as an assistant's.
	yes, ans := true, "Yes, every class is recorded."
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+f.sim.ID+"/questions/q-rec-0001",
		types.QuestionPatch{Answered: &yes, Answer: &ans}); res.StatusCode != http.StatusOK {
		t.Fatalf("host answer: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+f.sim.ID+"/questions/q-rec-0001/retract", nil)
	h.wantError(res, raw, http.StatusNotFound, "not_found")
	if q := f.question("q-rec-0001"); q.AnswerBy != "" || !q.Answered {
		t.Fatalf("host answer = %+v", q)
	}
}

func TestQAAutoHostEditMakesItTheHostTeams(t *testing.T) {
	f := newAutoFixture(t, true)
	f.model.bySchema = map[string]string{"qa_auto": `{"answers":[{"question":"n1","answer":"It is 499 rupees.","grounded":true,"sources":["k1"]}]}`}
	f.ask(f.guests[0], "q-fee-0002", "What is the course fee?")
	f.tick(f.guests[0])
	if q := f.question("q-fee-0002"); q.AnswerBy != assistant {
		t.Fatalf("auto answer = %+v", q)
	}
	edited := "It is 499 rupees, paid once. EMI on cards over 3,000 only."
	if res, raw := f.h.do(http.MethodPatch, "/api/host/webinars/"+f.sim.ID+"/questions/q-fee-0002",
		types.QuestionPatch{Answer: &edited}); res.StatusCode != http.StatusOK {
		t.Fatalf("edit: %d %s", res.StatusCode, raw)
	}
	if q := f.question("q-fee-0002"); q.AnswerBy != "" || q.Answer != edited || !q.Answered {
		t.Fatalf("edited = %+v", q)
	}
}

func TestQAAutoOffByDefaultAndGated(t *testing.T) {
	f := newAutoFixture(t, false)
	h, g := f.h, f.guests
	f.model.bySchema = map[string]string{"qa_auto": `{"answers":[{"question":"n1","answer":"499 rupees.","grounded":true,"sources":["k1"]}]}`}

	// Off by default.
	if ms := f.ask(g[0], "q-off-0001", "What is the fee?"); ms != 0 {
		t.Fatalf("auto off: autoAnswerInMs = %d", ms)
	}
	f.tick(g[0])
	var got types.SimuliveAutoAnswer
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+f.sim.ID+"/replay/auto", nil)
	h.decode(raw, &got)
	if res.StatusCode != http.StatusOK || got.Enabled || !got.Available || got.Label != assistant {
		t.Fatalf("setting = %d %+v", res.StatusCode, got)
	}

	// Needs replay_engage as well as ai.
	f.feature(types.FeatureReplayEngage, false)
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/auto", types.SimuliveAutoAnswerRequest{Enabled: true})
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	if err := h.store.SetSimuliveAutoAnswer(context.Background(), f.sim.ID, true); err != nil {
		t.Fatal(err)
	}
	if ms := f.ask(g[0], "q-off-0002", "What is the fee?"); ms != 0 {
		t.Fatal("auto mode ran without replay_engage")
	}
	f.feature(types.FeatureReplayEngage, true)
	f.feature(types.FeatureAI, false)
	if ms := f.ask(g[0], "q-off-0003", "What is the fee?"); ms != 0 {
		t.Fatal("auto mode ran without ai")
	}
	f.feature(types.FeatureAI, true)

	// The host switches it on: the next question is answered.
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+f.sim.ID+"/replay/auto", types.SimuliveAutoAnswerRequest{Enabled: true})
	h.decode(raw, &got)
	if res.StatusCode != http.StatusOK || !got.Enabled {
		t.Fatalf("switch on: %d %s", res.StatusCode, raw)
	}
	// The room's AI switch off (sessionAIAllowed false): no call at all.
	if res, raw := h.patchAI(f.sim.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("AI off: %d %s", res.StatusCode, raw)
	}
	if ms := f.ask(g[1], "q-off-0004", "What is the fee?"); ms != 0 {
		t.Fatal("auto mode with the room's AI off")
	}
	f.tick(g[1])
	if n := f.model.callCount(); n != 0 {
		t.Fatalf("calls with auto mode gated off = %d", n)
	}
	for _, id := range []string{"q-off-0001", "q-off-0002", "q-off-0003", "q-off-0004"} {
		if q := f.question(id); q.Answered {
			t.Fatalf("%s answered while gated: %+v", id, q)
		}
	}

	// The stage's own questions are never auto-answered.
	h.signup("Plain Host", "auto-plain-"+strings.ToLower(t.Name())+"@test.dev", true)
	live := h.liveWebinar("A live one", func(in *types.WebinarInput) { in.Options.SimuliveAutoAnswer = true })
	if live.Options.SimuliveAutoAnswer {
		t.Fatal("a live webinar kept the simulive's Auto mode")
	}
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+live.ID+"/replay/auto", types.SimuliveAutoAnswerRequest{Enabled: true})
	h.wantError(res, raw, http.StatusConflict, "not_simulive")
}

func TestQAAutoOnlyForTheAudience(t *testing.T) {
	f := newAutoFixture(t, true)
	res, raw := f.h.do(http.MethodPost, "/api/webinars/"+f.sim.ID+"/say", types.SendMessageRequest{
		Kind: types.MsgQuestion, ID: "q-host-0001", Text: "What is the fee?",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host question: %d %s", res.StatusCode, raw)
	}
	var out types.SendMessageResponse
	f.h.decode(raw, &out)
	if out.AutoAnswerInMs != 0 {
		t.Fatal("the host's own question went to Auto mode")
	}
	f.tick(f.guests[0])
	if f.model.callCount() != 0 {
		t.Fatal("a call for the stage's question")
	}
}

func TestQAAutoCapsPerSessionAndPerAsker(t *testing.T) {
	f := newAutoFixture(t, true)
	t.Cleanup(api.SetQAAuto(time.Millisecond, 4))
	g := f.guests
	all := `{"answers":[` +
		`{"question":"n1","answer":"499 rupees.","grounded":true,"sources":["k1"]},` +
		`{"question":"n2","answer":"499 rupees.","grounded":true,"sources":["k1"]},` +
		`{"question":"n3","answer":"499 rupees.","grounded":true,"sources":["k1"]},` +
		`{"question":"n4","answer":"499 rupees.","grounded":true,"sources":["k1"]}]}`
	f.model.bySchema = map[string]string{"qa_auto": all}

	// One asker, four questions: three answered, the fourth left for the host.
	for i, id := range []string{"q-cap-0001", "q-cap-0002", "q-cap-0003", "q-cap-0004"} {
		f.ask(g[0], id, "What is the fee, take "+string(rune('a'+i))+"?")
	}
	if n := f.tick(g[0]); n != 3 {
		t.Fatalf("answered = %d, want 3 (per-asker limit)", n)
	}
	if p := f.model.userPrompt(0); strings.Contains(p, "n4:") {
		t.Fatalf("the limited question reached the model: %s", p)
	}
	if q := f.question("q-cap-0004"); q.Answered {
		t.Fatal("over the asker's limit, but answered")
	}

	// Another asker: the session's cap (4) leaves room for one.
	f.ask(g[1], "q-cap-0005", "What is the fee for the course?")
	f.ask(g[1], "q-cap-0006", "How much is the fee?")
	if n := f.tick(g[1]); n != 1 {
		t.Fatalf("answered = %d, want 1 (session cap)", n)
	}
	if f.question("q-cap-0005").AnswerBy != assistant || f.question("q-cap-0006").Answered {
		t.Fatal("session cap")
	}
	if n := f.model.callCount(); n != 2 {
		t.Fatalf("calls = %d, want 2", n)
	}
	// Spent: no more calls.
	f.ask(g[2], "q-cap-0007", "Fee?")
	f.tick(g[2])
	if n := f.model.callCount(); n != 2 {
		t.Fatalf("calls after the cap = %d", n)
	}
}
