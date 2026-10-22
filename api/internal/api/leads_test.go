package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Hot leads and the follow-up writer, end to end against a fake gpt-5-nano: ranked in Go,
 * one model call per session for the reasons and one per language for the drafts, the
 * host's edits kept, and nothing at all with the AI switch off or a cap reached. */

const leadsReply = `{"reasons": [
  {"id": "1", "reason": "Asked about the 1:1 plan's price twice and stayed to the end."},
  {"id": "2", "reason": "Stayed most of the session."},
  {"id": "99", "reason": "Nobody asked about this id."}
]}`

const followupsReply = `{"drafts": [
  {"group": "hot", "emailSubject": "Your question about the 1:1 plan", "emailBody": "Hi {{first_name}},\n\nThank you for asking.\n\nEngagement Host", "whatsapp": "Hi {{first_name}}, thank you for your questions today."},
  {"group": "attended", "emailSubject": "Thanks for joining", "emailBody": "Hi {{first_name}},\n\nThanks for staying.", "whatsapp": "Hi {{first_name}}, thanks for joining. Replay: {{replay_link}}"},
  {"group": "left_early", "emailSubject": "What you missed", "emailBody": "Hi {{first_name}},\n\nHere is what we covered.", "whatsapp": "Hi {{first_name}}, here is what you missed."},
  {"group": "no_show", "emailSubject": "We missed you", "emailBody": "Hi {{first_name}},\n\nWe missed you.", "whatsapp": "Hi {{first_name}}, we missed you today."}
]}`

func (f *fakeOpenAI) setReply(reply string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reply = reply
}

func (h *harness) getLeads(slug string) types.LeadsResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/leads", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("leads: %d %s", res.StatusCode, raw)
	}
	var out types.LeadsResponse
	h.decode(raw, &out)
	return out
}

func (h *harness) getFollowups(slug, lang string) types.FollowupsResponse {
	h.t.Helper()
	path := "/api/host/webinars/" + slug + "/followups"
	if lang != "" {
		path += "?lang=" + lang
	}
	res, raw := h.do(http.MethodGet, path, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("followups: %d %s", res.StatusCode, raw)
	}
	var out types.FollowupsResponse
	h.decode(raw, &out)
	return out
}

func (h *harness) aiUsageRows(feature string) int {
	h.t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), `SELECT count(*) FROM ai_usage WHERE feature = $1`, feature).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

/* leadsWebinar is engagedWebinar (an ended hour: keen stayed it all and chatted, quiet 39
 * minutes, brief 5, absent never came) with keen asking about the price twice. */
func leadsWebinar(t *testing.T, h *harness, aiOn bool) (types.Webinar, []types.Registration) {
	t.Helper()
	wb, regs := engagedWebinar(t, h)
	ctx := context.Background()
	for i, q := range []string{"What does the 1:1 plan cost?", "Is there an EMI option for the plan?"} {
		if err := h.store.UpsertSessionQuestion(ctx, wb.ID, types.SessionQuestion{
			ID: "lq" + string(rune('a'+i)), Identity: "att_" + regs[0].JoinKey, Name: "Keen", Text: q,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if aiOn {
		host, err := h.store.UserByEmail(ctx, "engagement-host@test.dev")
		if err != nil {
			t.Fatal(err)
		}
		enableAIForUser(t, h, host.ID)
	}
	return wb, regs
}

func leadByEmail(ls []types.Lead, email string) types.Lead {
	for _, l := range ls {
		if l.Email == email {
			return l
		}
	}
	return types.Lead{}
}

func TestLeadsAreRankedAndTheReasonsWrittenOnce(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	wb, _ := leadsWebinar(t, h, true)

	got := h.getLeads(wb.ID)
	if got.AIStatus != types.AIStatusReady || got.SessionMin != 60 || len(got.Leads) != 4 {
		t.Fatalf("leads = %+v", got)
	}
	order := []string{}
	for _, l := range got.Leads {
		order = append(order, strings.Split(l.Email, "@")[0])
	}
	if strings.Join(order, ",") != "keen,quiet,brief,absent" {
		t.Fatalf("order = %v", order)
	}
	keen := got.Leads[0]
	// 40 (stayed it all) + 20 (two questions) + 2 (one chat message).
	if keen.Score != 62 || keen.Tag != "hot" || keen.Group != "attended" || keen.Signals.Questions != 2 ||
		keen.Signals.Chats != 1 || keen.Signals.WatchPct != 100 || keen.RegistrationID == "" {
		t.Fatalf("keen = %+v", keen)
	}
	if keen.Reason != "Asked about the 1:1 plan's price twice and stayed to the end." {
		t.Fatalf("keen's reason = %q", keen.Reason)
	}
	if q := leadByEmail(got.Leads, "quiet@test.dev"); q.Group != "attended" || q.Tag != "cold" || q.Reason == "" {
		t.Errorf("quiet = %+v", q)
	}
	if b := leadByEmail(got.Leads, "brief@test.dev"); b.Group != "left_early" {
		t.Errorf("brief = %+v", b)
	}
	if a := leadByEmail(got.Leads, "absent@test.dev"); a.Group != "no_show" || a.Score != 0 || a.Reason != "" || a.Signals.Joined {
		t.Errorf("absent = %+v", a)
	}

	// One call, with the person's own questions and none of their contact details.
	if model.callCount() != 1 {
		t.Fatalf("model calls = %d", model.callCount())
	}
	msg := userMessage(model.lastBody())
	for _, want := range []string{"What does the 1:1 plan cost?", "Is there an EMI option", "watched 60 of 60 min live"} {
		if !strings.Contains(msg, want) {
			t.Errorf("prompt is missing %q: %s", want, msg)
		}
	}
	if strings.Contains(msg, "keen@test.dev") || strings.Contains(msg, "absent") {
		t.Errorf("the prompt carries an email or a no-show: %s", msg)
	}

	// Opening Results again reads the cache.
	again := h.getLeads(wb.ID)
	if model.callCount() != 1 || again.Leads[0].Reason != keen.Reason {
		t.Fatalf("second load: %d calls, reason %q", model.callCount(), again.Leads[0].Reason)
	}
	if n := h.aiUsageRows(types.AIFeatureLeads); n != 1 {
		t.Errorf("ai_usage leads rows = %d", n)
	}
}

func TestLeadsAndFollowupsWithTheSwitchOffCallNothing(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	wb, _ := leadsWebinar(t, h, false)

	got := h.getLeads(wb.ID)
	if got.AIStatus != "ai_off" || len(got.Leads) != 4 || got.Leads[0].Reason != "" || got.Leads[0].Tag != "hot" {
		t.Fatalf("leads with ai off = %+v", got)
	}
	f := h.getFollowups(wb.ID, "")
	if f.Status != "ai_off" || len(f.Groups) != 4 || f.Groups[0].Draft != nil {
		t.Fatalf("followups with ai off = %+v", f)
	}
	if model.callCount() != 0 {
		t.Fatalf("model called %d times with the switch off", model.callCount())
	}
}

func TestLeadsAndFollowupsAtTheCap(t *testing.T) {
	h, model := aiHarness(t, leadsReply, func(c *config.Config) { c.AIHostMonthlyUSD = 0 })
	wb, _ := leadsWebinar(t, h, true)

	if got := h.getLeads(wb.ID); got.AIStatus != "ai_limit" || len(got.Leads) != 4 {
		t.Fatalf("leads at the cap = %+v", got)
	}
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/followups", nil)
	h.wantError(res, raw, http.StatusTooManyRequests, "ai_limit")
	if model.callCount() != 0 {
		t.Fatalf("model called %d times past the cap", model.callCount())
	}
}

func TestLeadsAndFollowupsAreTheHostsOnly(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	wb, _ := leadsWebinar(t, h, true)
	h.logout()
	other := h.signup("Other Host", "other-leads-host@test.dev", true)
	enableAIForUser(t, h, other.ID)
	for _, path := range []string{"/leads", "/followups"} {
		res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+path, nil)
		if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
			t.Errorf("%s as another host: %d %s", path, res.StatusCode, raw)
		}
	}
	res, raw := h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/followups/hot",
		types.FollowupEditRequest{Draft: types.FollowupDraft{EmailSubject: "x"}})
	if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Errorf("edit as another host: %d %s", res.StatusCode, raw)
	}
	h.logout()
	if res, _ := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/leads", nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: %d", res.StatusCode)
	}
	if model.callCount() != 0 {
		t.Fatalf("model called %d times for somebody else", model.callCount())
	}
}

func TestFollowupsAreWrittenOnceAndEditsKept(t *testing.T) {
	h, model := aiHarness(t, followupsReply, nil)
	wb, _ := leadsWebinar(t, h, true)

	got := h.getFollowups(wb.ID, "")
	if got.Status != types.AIStatusReady || got.Language != "en" || len(got.Groups) != 4 {
		t.Fatalf("followups = %+v", got)
	}
	counts := map[string]int{}
	for _, g := range got.Groups {
		counts[g.Group] = g.Count
		if g.Draft == nil || g.Edited {
			t.Errorf("group %s draft = %+v edited %v", g.Group, g.Draft, g.Edited)
		}
	}
	if counts["hot"] != 1 || counts["attended"] != 2 || counts["left_early"] != 1 || counts["no_show"] != 1 {
		t.Fatalf("counts = %v", counts)
	}
	// No public recording: the replay placeholder is taken out rather than sent as braces.
	if g := got.Groups[1]; g.Group != "attended" || strings.Contains(g.Draft.WhatsApp, "{{replay_link}}") ||
		!strings.Contains(g.Draft.WhatsApp, "{{first_name}}") {
		t.Errorf("attended = %+v", g.Draft)
	}
	if model.callCount() != 1 {
		t.Fatalf("model calls = %d", model.callCount())
	}
	msg := userMessage(model.lastBody())
	for _, want := range []string{"Engagement", "no_show:", "hot:", "There is no replay"} {
		if !strings.Contains(msg, want) {
			t.Errorf("prompt is missing %q: %s", want, msg)
		}
	}

	// The host edits the no-show draft; the edit is kept, and nothing is written again.
	edit := types.FollowupDraft{EmailSubject: "Sorry we missed you", EmailBody: "Hi {{first_name}},\n\nMy own words.", WhatsApp: "Hi {{first_name}} 🙏"}
	res, raw := h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/followups/no_show", types.FollowupEditRequest{Draft: edit})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("edit: %d %s", res.StatusCode, raw)
	}
	again := h.getFollowups(wb.ID, "")
	ns := again.Groups[3]
	if ns.Group != "no_show" || !ns.Edited || ns.Draft == nil || *ns.Draft != edit {
		t.Fatalf("no_show after the edit = %+v %+v", ns, ns.Draft)
	}
	if again.Groups[0].Edited {
		t.Fatal("an edit leaked into another group")
	}
	if model.callCount() != 1 {
		t.Fatalf("model calls after edit and reload = %d", model.callCount())
	}

	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/followups/everyone", types.FollowupEditRequest{Draft: edit})
	h.wantError(res, raw, http.StatusNotFound, "not_found")
	long := edit
	long.WhatsApp = strings.Repeat("a", 1025)
	res, raw = h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/followups/hot", types.FollowupEditRequest{Draft: long})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "too_long")

	// Hinglish, picked by the host: written once too, and kept apart from the English edits.
	hi := h.getFollowups(wb.ID, "hinglish")
	if hi.Language != "hinglish" || hi.Status != types.AIStatusReady || hi.Groups[3].Edited {
		t.Fatalf("hinglish = %+v", hi)
	}
	if !strings.Contains(model.lastBody()["messages"].([]any)[0].(map[string]any)["content"].(string), "Roman (Latin) script") {
		t.Error("the Hinglish call did not ask for Hinglish")
	}
	h.getFollowups(wb.ID, "hinglish")
	if model.callCount() != 2 {
		t.Fatalf("model calls with hinglish twice = %d", model.callCount())
	}
	// With no pick, the first language written (English) is the one shown.
	if d := h.getFollowups(wb.ID, ""); d.Language != "en" || !d.Groups[3].Edited {
		t.Fatalf("default after both = %+v", d)
	}
	if n := h.aiUsageRows(types.AIFeatureFollowups); n != 2 {
		t.Errorf("ai_usage followups rows = %d", n)
	}
}

func TestLeadsAndFollowupsBeforeTheEnd(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	recapHost(t, h)
	wb := h.liveWebinar("Still live", nil)
	if got := h.getLeads(wb.ID); got.AIStatus != "not_ended" {
		t.Fatalf("leads while live = %+v", got)
	}
	if got := h.getFollowups(wb.ID, ""); got.Status != "not_ended" {
		t.Fatalf("followups while live = %+v", got)
	}
	res, raw := h.do(http.MethodPut, "/api/host/webinars/"+wb.ID+"/followups/hot",
		types.FollowupEditRequest{Draft: types.FollowupDraft{EmailSubject: "x"}})
	h.wantError(res, raw, http.StatusConflict, "no_drafts")
	if model.callCount() != 0 {
		t.Fatalf("model calls before the end = %d", model.callCount())
	}
}

func TestLeadsForAMeeting(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	host := meetingHost(t, h)
	enableAIForUser(t, h, host.ID)
	wb := h.instantMeeting("Weekly stand-up", nil)
	h.goLive(wb.ID)
	h.endSession(wb.ID)
	got := h.getLeads(wb.ID)
	if got.AIStatus != "empty" || len(got.Leads) != 0 {
		t.Fatalf("meeting with nobody = %+v", got)
	}
	if f := h.getFollowups(wb.ID, ""); f.Status != "empty" {
		t.Fatalf("meeting followups = %+v", f)
	}
	if model.callCount() != 0 {
		t.Fatalf("model calls for an empty meeting = %d", model.callCount())
	}
}
