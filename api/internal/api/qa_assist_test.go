package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The live Q&A assistant (qa_assist.go), against the fake gpt-5-nano: duplicate questions
 * grouped in batches (never a call per question), once at a time, persisted; host-only; off
 * with the room's AI switch; paused at a cap; a private suggested answer. */

// setReply is in leads_test.go.

func (f *fakeOpenAI) userPrompt(i int) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	msgs, _ := f.bodies[i]["messages"].([]any)
	for _, m := range msgs {
		if mm, _ := m.(map[string]any); mm["role"] == "user" {
			s, _ := mm["content"].(string)
			return s
		}
	}
	return ""
}

// qaSetup is a live session whose host has AI, with the check on the request path and no
// time trigger, and three registered guests.
func qaSetup(t *testing.T, reply string, tweak func(*config.Config)) (*harness, *fakeOpenAI, types.Webinar, []types.Registration) {
	t.Helper()
	t.Cleanup(api.SetQAClusterTiming(true, time.Hour))
	h, model := aiHarness(t, reply, tweak)
	email := "qa-host-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-")) + "@test.dev"
	h.signup("QA Host", email, true)
	enableAI(t, h, email)
	wb := h.liveWebinar("Money basics for your first salary", nil)
	var guests []types.Registration
	for _, g := range []string{"asha", "ravi", "meera"} {
		guests = append(guests, h.registerAsGuest(wb.ID, "qa-"+g+"-"+strings.ToLower(t.Name())+"@test.dev"))
	}
	return h, model, wb, guests
}

func (h *harness) ask(slug string, guest types.Registration, id, text string) {
	h.t.Helper()
	h.mustSayAsGuest(slug, types.SendMessageRequest{JoinKey: guest.JoinKey, Kind: types.MsgQuestion, ID: id, Text: text})
}

func (h *harness) qaClusters(slug string) types.QAClustersResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/qa/clusters", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("qa clusters: %d %s", res.StatusCode, raw)
	}
	var out types.QAClustersResponse
	h.decode(raw, &out)
	return out
}

// qaPackets is every qa-clusters packet handed to the SFU, by recipient list.
func (h *harness) qaPackets() [][]string {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	var out [][]string
	for _, p := range h.rooms.sent {
		var m map[string]any
		if json.Unmarshal(p.data, &m) == nil && m["kind"] == "qa-clusters" {
			out = append(out, p.to)
		}
	}
	return out
}

const feeClusters = `{"groups":[{"existing":"","canonical":"What does the course cost?","questions":["n1","n2"]}]}`

func TestQAAssistBatchesGroupsAndPersists(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	host := h.hostWebinar(wb.ID).Host

	// Two questions: below the batch, so no pass and no call.
	h.ask(wb.ID, g[0], "q-fee-0001", "What is the fee?")
	h.ask(wb.ID, g[1], "q-cost-001", "How much does the course cost?")
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls after two questions = %d, want 0 (batched, not per question)", n)
	}
	// The third makes the batch. "what is the fee??" is the first one again, to the free
	// pre-pass, so the model sees two groups, not three questions.
	h.ask(wb.ID, g[2], "q-fee-0002", "what is the fee??")
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls after the batch = %d, want 1", n)
	}
	if p := model.userPrompt(0); !strings.Contains(p, "n1: What is the fee?") || !strings.Contains(p, "n2: How much") || strings.Contains(p, "n3:") {
		t.Fatalf("grouping prompt = %q", p)
	}

	out := h.qaClusters(wb.ID)
	if !out.Enabled || out.Limited || len(out.Clusters) != 1 {
		t.Fatalf("clusters = %+v", out)
	}
	c := out.Clusters[0]
	if c.Canonical != "What does the course cost?" || c.Askers != 3 || c.Open != 3 || len(c.QuestionIDs) != 3 || c.Provisional {
		t.Fatalf("cluster = %+v", c)
	}
	if n := model.callCount(); n != 1 {
		t.Fatalf("reading the clusters called the model: %d", n)
	}

	// Host-only: the change went to the host's identity, never to the whole room.
	packets := h.qaPackets()
	if len(packets) == 0 {
		t.Fatal("no qa-clusters packet")
	}
	for _, to := range packets {
		if len(to) != 1 || to[0] != "user_"+host.ID {
			t.Fatalf("qa-clusters packet to %v, want the host only", to)
		}
	}

	// A fourth that the pre-pass recognises joins the cluster with no call, once due.
	h.ask(wb.ID, g[1], "q-fee-0003", "What is the FEE")
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls after one more = %d", n)
	}
	restore := api.SetQAClusterTiming(true, 0)
	out = h.qaClusters(wb.ID)
	restore()
	if len(out.Clusters) != 1 || len(out.Clusters[0].QuestionIDs) != 4 || model.callCount() != 1 {
		t.Fatalf("after the pre-pass: %+v, calls %d", out.Clusters, model.callCount())
	}

	// Persisted: a co-host, signing in fresh, sees the same cluster.
	co := h.signup("QA CoHost", "qa-cohost@test.dev", true)
	if err := h.store.SetCoHost(context.Background(), wb.ID, "user_"+co.ID, "QA CoHost", true); err != nil {
		t.Fatal(err)
	}
	h.login("qa-cohost@test.dev")
	again := h.qaClusters(wb.ID)
	if len(again.Clusters) != 1 || again.Clusters[0].ID != c.ID {
		t.Fatalf("co-host sees %+v, want cluster %s", again.Clusters, c.ID)
	}

	st := h.adminAI()
	found := false
	for _, f := range st.Month.Features {
		if f.Feature == types.AIFeatureQACluster && f.Calls == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("ai usage = %+v, want one qa_cluster call", st.Month.Features)
	}
}

func TestQAAssistOneQuestionNeedsNoCall(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	h.ask(wb.ID, g[0], "q-solo-001", "Will the slides be shared?")
	restore := api.SetQAClusterTiming(true, 0)
	defer restore()
	out := h.qaClusters(wb.ID)
	if len(out.Clusters) != 1 || out.Clusters[0].Provisional || out.Clusters[0].Canonical != "Will the slides be shared?" {
		t.Fatalf("clusters = %+v", out.Clusters)
	}
	if n := model.callCount(); n != 0 {
		t.Fatalf("one question with nothing to merge with called the model %d times", n)
	}
}

func TestQAAssistOnePassInFlight(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	// Another instance holds the pass.
	release, ok, err := h.store.TryLease(context.Background(), "qa_cluster:"+wb.ID, time.Minute)
	if err != nil || !ok {
		t.Fatalf("lease: %v %v", ok, err)
	}
	h.ask(wb.ID, g[0], "q-a-000001", "Fee?")
	h.ask(wb.ID, g[1], "q-b-000001", "Cost?")
	h.ask(wb.ID, g[2], "q-c-000001", "Recording?")
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls while another pass runs = %d", n)
	}
	out := h.qaClusters(wb.ID)
	if len(out.Clusters) != 3 || !out.Clusters[0].Provisional || model.callCount() != 0 {
		t.Fatalf("while held: %+v, calls %d", out.Clusters, model.callCount())
	}
	release()
	h.qaClusters(wb.ID)
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls once released = %d, want 1", n)
	}
}

func TestQAAssistOffWithTheRoomSwitch(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("AI off: %d %s", res.StatusCode, raw)
	}
	h.ask(wb.ID, g[0], "q-a-000002", "Fee?")
	h.ask(wb.ID, g[1], "q-b-000002", "Cost?")
	h.ask(wb.ID, g[2], "q-c-000002", "Price?")
	out := h.qaClusters(wb.ID)
	if out.Enabled || len(out.Clusters) != 0 || len(out.Top) != 0 {
		t.Fatalf("clusters with AI off = %+v", out)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/clusters/q_q-a-000002/suggest", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "ai_off" {
		t.Fatalf("suggest with AI off: %d %s", res.StatusCode, raw)
	}
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls with AI off = %d", n)
	}
	if len(h.qaPackets()) != 0 {
		t.Fatal("a qa-clusters packet with AI off")
	}
}

func TestQAAssistWithoutTheFeature(t *testing.T) {
	t.Cleanup(api.SetQAClusterTiming(true, 0))
	h, model := aiHarness(t, feeClusters, nil)
	h.signup("Plain Host", "qa-plain@test.dev", true)
	wb := h.liveWebinar("No AI", nil)
	g := h.registerAsGuest(wb.ID, "qa-plain-guest@test.dev")
	h.ask(wb.ID, g, "q-plain-01", "Fee?")
	h.ask(wb.ID, g, "q-plain-02", "Cost?")
	h.ask(wb.ID, g, "q-plain-03", "Price?")
	if out := h.qaClusters(wb.ID); out.Enabled || model.callCount() != 0 {
		t.Fatalf("without the feature: %+v, calls %d", out, model.callCount())
	}
}

func TestQAAssistPausesAtTheCap(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, func(c *config.Config) { c.AIHostMonthlyUSD = 0.01 })
	host := h.hostWebinar(wb.ID).Host
	// The host's month is spent (one $0.045 call over a $0.01 cap).
	if _, err := api.AIComplete(h.server, context.Background(), types.AIFeatureRecap, host.ID, aiHello); err != nil {
		t.Fatal(err)
	}
	h.ask(wb.ID, g[0], "q-a-000003", "Fee?")
	h.ask(wb.ID, g[1], "q-b-000003", "Cost?")
	h.ask(wb.ID, g[2], "q-c-000003", "Recording?")
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls = %d, want only the one that spent the month", n)
	}
	out := h.qaClusters(wb.ID)
	if !out.Enabled || !out.Limited || len(out.Clusters) != 3 {
		t.Fatalf("at the cap: %+v", out)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/clusters/q_q-a-000003/suggest", nil)
	if res.StatusCode != http.StatusTooManyRequests || errorCode(t, raw) != "ai_limit" || !strings.Contains(string(raw), "answer by hand") {
		t.Fatalf("suggest at the cap: %d %s", res.StatusCode, raw)
	}
	// Paused: more questions do not knock on the cap.
	h.ask(wb.ID, g[0], "q-d-000003", "EMI?")
	h.ask(wb.ID, g[1], "q-e-000003", "Refund?")
	h.ask(wb.ID, g[2], "q-f-000003", "Certificate?")
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls while paused = %d", n)
	}
}

func TestQAAssistSuggestIsPrivateAndHostOnly(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	ctx := context.Background()
	host := h.hostWebinar(wb.ID).Host
	h.ask(wb.ID, g[0], "q-fee-0001", "Fees kitni hai?")
	h.ask(wb.ID, g[1], "q-fee-0002", "Course ka price kya hai?")
	h.ask(wb.ID, g[2], "q-rec-0001", "Recording milegi?")
	cluster := h.qaClusters(wb.ID).Clusters[0]
	h.caption(wb.ID, "user_"+host.ID, "The full course is 499 rupees, and early birds get 20 percent off.")

	model.setReply(`{"answer":"**Course** ki fee 499 rupees hai.\n- Early birds ko 20 percent off milta hai.","grounded":true,"sources":[]}`)
	before := len(h.rooms.sent)
	path := "/api/host/webinars/" + wb.ID + "/qa/clusters/" + cluster.ID + "/suggest"
	res, raw := h.do(http.MethodPost, path, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("suggest: %d %s", res.StatusCode, raw)
	}
	var out types.QASuggestResponse
	h.decode(raw, &out)
	if out.Answer != "Course ki fee 499 rupees hai. Early birds ko 20 percent off milta hai." {
		t.Fatalf("answer = %q", out.Answer)
	}
	p := model.userPrompt(model.callCount() - 1)
	for _, want := range []string{"Money basics", "What does the course cost?", "Fees kitni hai?", "499 rupees"} {
		if !strings.Contains(p, want) {
			t.Errorf("suggest prompt missing %q: %s", want, p)
		}
	}
	// From the transcript, with no knowledge: grounded, no sources, no "Not in your knowledge".
	if !out.Draft.Grounded || len(out.Draft.Sources) != 0 || out.Draft.Auto || out.Draft.Answer != out.Answer {
		t.Fatalf("draft = %+v", out.Draft)
	}
	// Private: nothing but the host team's re-read nudge went to the room, and nothing was
	// written on the question.
	h.rooms.mu.Lock()
	for _, pk := range h.rooms.sent[before:] {
		if !strings.Contains(string(pk.data), `"qa-clusters"`) || len(pk.to) != 1 || pk.to[0] != "user_"+host.ID {
			t.Errorf("a suggested answer went to the room: %s to %v", pk.data, pk.to)
		}
	}
	h.rooms.mu.Unlock()
	var answer string
	if err := h.store.Pool().QueryRow(ctx, `SELECT answer FROM session_questions WHERE id = 'q-fee-0001'`).Scan(&answer); err != nil || answer != "" {
		t.Fatalf("stored answer = %q %v", answer, err)
	}

	// Another host: not theirs.
	h.signup("Other Host", "qa-other-host@test.dev", true)
	if res, _ := h.do(http.MethodPost, path, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("other host: %d", res.StatusCode)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/qa/clusters", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("other host clusters: %d", res.StatusCode)
	}
	// An attendee: no session at all.
	h.logout()
	if res, _ := h.do(http.MethodPost, path, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("attendee: %d", res.StatusCode)
	}
	// An unknown cluster id.
	co := h.signup("Suggest CoHost", "qa-suggest-co@test.dev", true)
	if err := h.store.SetCoHost(ctx, wb.ID, "user_"+co.ID, "Co", true); err != nil {
		t.Fatal(err)
	}
	if res, _ := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/clusters/qc_nope/suggest", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown cluster: %d", res.StatusCode)
	}
	// A co-host may, charged to the host.
	if res, raw := h.do(http.MethodPost, path, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("co-host suggest: %d %s", res.StatusCode, raw)
	}
	var hostID string
	if err := h.store.Pool().QueryRow(ctx, `SELECT host_id::text FROM ai_usage WHERE feature = 'qa_answer' ORDER BY created_at DESC LIMIT 1`).Scan(&hostID); err != nil || hostID != host.ID {
		t.Fatalf("qa_answer charged to %q (%v), want the host", hostID, err)
	}
}

func TestQAAssistPacketReachesCoHosts(t *testing.T) {
	h, _, wb, g := qaSetup(t, feeClusters, nil)
	host := h.hostWebinar(wb.ID).Host
	h.rooms.mu.Lock()
	h.rooms.roster = []types.LiveParticipant{
		{Identity: "user_" + host.ID, Role: types.RoleHost},
		{Identity: "user_cohost", Role: types.RolePanelist, CoHost: true},
		{Identity: "user_panelist", Role: types.RolePanelist},
		{Identity: "att_x", Role: types.RoleAttendee},
	}
	h.rooms.mu.Unlock()
	h.ask(wb.ID, g[0], "q-a-000004", "Fee?")
	h.ask(wb.ID, g[1], "q-b-000004", "Cost?")
	h.ask(wb.ID, g[2], "q-c-000004", "Price?")
	packets := h.qaPackets()
	if len(packets) != 1 {
		t.Fatalf("packets = %v", packets)
	}
	if to := strings.Join(packets[0], ","); to != "user_"+host.ID+",user_cohost" {
		t.Fatalf("qa-clusters to %s, want the host and the co-host only", to)
	}
}
