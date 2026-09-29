package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func ruleTag(t *testing.T, h *harness, name string) types.CRMTag {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/tags", types.CRMTagRequest{Name: name})
	if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
		t.Fatalf("create tag: %d %s", res.StatusCode, raw)
	}
	var tag types.CRMTag
	h.decode(raw, &tag)
	return tag
}

func contactTags(t *testing.T, h *harness, contactID string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, tg := range threadFor(t, h, contactID).Contact.Tags {
		out[tg.Name] = true
	}
	return out
}

/* A rule the host writes: When someone answers "Yes" to "Want 1:1 coaching?" → tag them
 * and tell me. The vote in the room enrolls them; the sweep runs the steps, which send
 * nothing to the person; a "No" enrolls nobody. */
func TestRulePollAnswer(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhatsAppCRM)
	connectWhatsApp(t, h)
	tag := ruleTag(t, h, "Wants 1:1")

	// A poll answer rule needs its question.
	if res, _ := h.do(http.MethodPost, "/api/host/crm/drips", types.CRMDripRequest{
		Name: "No question", Trigger: types.DripPollAnswer, Active: true,
		Steps: []types.CRMDripStep{{Kind: types.DripStepNotify}},
	}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("rule without a question = %d, want 422", res.StatusCode)
	}

	rule := createDrip(t, h, types.CRMDripRequest{
		Name: "1:1 interest", Trigger: types.DripPollAnswer, Active: true,
		Match: &types.CRMDripMatch{Question: "Want 1:1 coaching?", Answer: "yes"},
		Steps: []types.CRMDripStep{
			{Kind: types.DripStepTag, TagID: tag.ID},
			{Kind: types.DripStepNotify, Note: "Call them this week."},
		},
	}).Drip
	if rule.Match == nil || rule.Match.Question != "Want 1:1 coaching?" || len(rule.Steps) != 2 ||
		rule.Steps[0].Kind != types.DripStepTag || rule.Steps[0].TagName != "Wants 1:1" {
		t.Fatalf("rule = %+v", rule)
	}

	wb := h.liveWebinar("Rules", nil)
	yes := h.registerAsGuest(wb.ID, "yes@test.dev")
	no := h.registerAsGuest(wb.ID, "no@test.dev")
	for _, r := range []types.Registration{yes, no} {
		if err := h.store.TouchAttendance(context.Background(), wb.ID, "att_"+r.JoinKey, r.ID, r.Email); err != nil {
			t.Fatal(err)
		}
	}
	poll := h.createPoll(wb.ID, types.PollInput{Question: "  want 1:1   coaching? ", Kind: types.PollOpinion,
		Options: []string{"Yes", "No"}})
	h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil)
	if res, raw := h.voteAsGuest(wb.ID, poll.ID, yes.JoinKey, 0); res.StatusCode != http.StatusOK {
		t.Fatalf("vote yes: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.voteAsGuest(wb.ID, poll.ID, no.JoinKey, 1); res.StatusCode != http.StatusOK {
		t.Fatalf("vote no: %d %s", res.StatusCode, raw)
	}

	got := readDrip(t, h, rule.ID)
	if len(got.Enrollments) != 1 {
		t.Fatalf("enrolled %d, want only the Yes voter: %+v", len(got.Enrollments), got.Enrollments)
	}
	who := got.Enrollments[0].ContactID

	// Two sweeps: the tag step, then the notify step. Nothing goes to WhatsApp.
	before := len(g.sent())
	h.engage.AdvanceDrips(context.Background())
	h.engage.AdvanceDrips(context.Background())
	if n := len(g.sent()) - before; n != 0 {
		t.Errorf("sends = %d, want none: tag and notify send nothing to the person", n)
	}
	if !contactTags(t, h, who)["Wants 1:1"] {
		t.Errorf("tags = %v, want Wants 1:1", contactTags(t, h, who))
	}
	if e := onlyEnrollment(t, readDrip(t, h, rule.ID)); e.State != "done" || e.Step != 2 {
		t.Errorf("enrollment = %+v, want done after 2 steps", e)
	}
}

/* When someone sends a word, or taps a button → a rule runs. STOP can't be a keyword. */
func TestRuleKeywordAndButton(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhatsAppCRM)
	connectWhatsApp(t, h)
	vip := ruleTag(t, h, "Asked about price")
	more := ruleTag(t, h, "Tapped more")

	if res, _ := h.do(http.MethodPost, "/api/host/crm/drips", types.CRMDripRequest{
		Name: "Stop", Trigger: types.DripKeywordIn, Active: true,
		Match: &types.CRMDripMatch{Word: "stop"},
		Steps: []types.CRMDripStep{{Kind: types.DripStepNotify}},
	}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("STOP keyword = %d, want 422", res.StatusCode)
	}

	word := createDrip(t, h, types.CRMDripRequest{
		Name: "Price", Trigger: types.DripKeywordIn, Active: true,
		Match: &types.CRMDripMatch{Word: "price"},
		Steps: []types.CRMDripStep{{Kind: types.DripStepTag, TagID: vip.ID}},
	}).Drip
	btn := createDrip(t, h, types.CRMDripRequest{
		Name: "More", Trigger: types.DripButtonTap, Active: true,
		Match: &types.CRMDripMatch{Text: "Tell me more"},
		Steps: []types.CRMDripStep{{Kind: types.DripStepTag, TagID: more.ID}},
	}).Drip

	wb := autoWebinar(t, h, "Words")
	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	postWebhook(t, h, inboundNow("wamid.K1", crmPhoneDigits, "Thandi", "What's the PRICE of this?"))
	postWebhook(t, h, buttonTap("wamid.K2", crmPhoneDigits, "Tell me more"))
	h.engage.AdvanceDrips(context.Background())

	if len(readDrip(t, h, word.ID).Enrollments) != 1 || len(readDrip(t, h, btn.ID).Enrollments) != 1 {
		t.Fatalf("keyword %d, button %d enrollments, want 1 each",
			len(readDrip(t, h, word.ID).Enrollments), len(readDrip(t, h, btn.ID).Enrollments))
	}
	tags := contactTags(t, h, thandi.ID)
	if !tags["Asked about price"] || !tags["Tapped more"] {
		t.Errorf("tags = %v", tags)
	}
	// The same word again enrolls nobody twice.
	postWebhook(t, h, inboundNow("wamid.K3", crmPhoneDigits, "Thandi", "price?"))
	if n := len(readDrip(t, h, word.ID).Enrollments); n != 1 {
		t.Errorf("enrollments after a second message = %d, want 1", n)
	}
}
