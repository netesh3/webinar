package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

/* Sending the AI follow-ups from Results, end to end against a fake Graph, a fake model and
 * a captured mailbox: the window decides free-form against template, the template has to
 * be approved, no opt-in means email, an unsubscribe is honoured, nothing goes twice
 * without "send again", every send is filed where replies land, and only the host may. */

func (h *harness) followupPlan(slug string, keys []string) types.FollowupPlanResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/followups/plan", types.FollowupPlanRequest{Keys: keys})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("plan: %d %s", res.StatusCode, raw)
	}
	var out types.FollowupPlanResponse
	h.decode(raw, &out)
	return out
}

func (h *harness) followupSend(slug string, again bool, items ...types.FollowupSendItem) []types.FollowupSendResult {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/followups/send", types.FollowupSendRequest{Items: items, Again: again})
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("send: %d %s", res.StatusCode, raw)
	}
	var out types.FollowupSendResponse
	h.decode(raw, &out)
	return out.Results
}

func recipientByEmail(t *testing.T, p types.FollowupPlanResponse, email string) types.FollowupRecipient {
	t.Helper()
	for _, r := range p.Recipients {
		if r.Email == email {
			return r
		}
	}
	t.Fatalf("no recipient %s in %+v", email, p.Recipients)
	return types.FollowupRecipient{}
}

func (g *fakeGraph) approveAll() {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, t := range g.templates {
		t["status"] = "APPROVED"
	}
}

func TestFollowupsAreSentOnlyWhenTheHostSends(t *testing.T) {
	g := newFakeGraph(t)
	h, _ := aiHarness(t, followupsReply, whatsappConfigured(g.srv.URL))
	mail := &fakeMail{}
	h.server.UseMail(mail)

	h.signup("Fola Host", "fola@test.dev", true)
	host, err := h.store.UserByEmail(context.Background(), "fola@test.dev")
	if err != nil {
		t.Fatal(err)
	}
	enableAIForUser(t, h, host.ID)
	connectWhatsApp(t, h)
	wb := h.liveWebinar("Money basics", nil)
	registerWithPhone(t, h, wb.ID, "Asha", "asha@test.dev", "+27 83 111 0001", true)
	registerWithPhone(t, h, wb.ID, "Bongi", "bongi@test.dev", "+27 83 111 0002", false)
	chen := registerWithPhone(t, h, wb.ID, "Chen", "chen@test.dev", "+27 83 111 0003", true)
	// Chen wrote in a minute ago: the 24-hour window is open for him.
	postWebhook(t, h, inboundNow("wamid.IN-chen", "27831110003", "Chen", "Thanks!"))

	for _, step := range []string{"/end"} {
		if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+step, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s", step, res.StatusCode, raw)
		}
	}
	// Opening Results writes the drafts; nothing is sent by that.
	if f := h.getFollowups(wb.ID, ""); f.Status != types.AIStatusReady {
		t.Fatalf("followups = %+v", f)
	}
	sendsBefore := len(g.sent())
	for _, m := range mail.sent {
		if m.ListUnsubscribe != "" {
			t.Fatalf("a follow-up email before any send: %+v", m)
		}
	}

	keys := []string{}
	for _, l := range h.getLeads(wb.ID).Leads {
		keys = append(keys, l.Key)
	}
	plan := h.followupPlan(wb.ID, keys)
	if !plan.WhatsAppConnected || !plan.EmailEnabled || plan.TemplateStatus != "" || len(plan.Recipients) != 3 {
		t.Fatalf("plan = %+v", plan)
	}
	asha, bongi, chenR := recipientByEmail(t, plan, "asha@test.dev"), recipientByEmail(t, plan, "bongi@test.dev"),
		recipientByEmail(t, plan, "chen@test.dev")
	// Outside the window with no approved template: WhatsApp is not offered.
	if asha.WAPlan.Available || asha.WAPlan.Reason != types.FollowupReasonTemplate || !asha.EmailPlan.Available {
		t.Fatalf("asha = %+v", asha)
	}
	// No opt-in: WhatsApp never; email is the fallback.
	if bongi.WAPlan.Available || bongi.WAPlan.Reason != types.FollowupReasonNoOptIn || !bongi.EmailPlan.Available {
		t.Fatalf("bongi = %+v", bongi)
	}
	// Inside the window: free-form.
	if !chenR.WAPlan.Available || chenR.WAPlan.Mode != types.FollowupModeFreeform || chenR.ContactID != chen.ID {
		t.Fatalf("chen = %+v", chenR)
	}
	// The drafts are filled in for each person.
	if !strings.HasPrefix(asha.WhatsApp, "Hi Asha,") || strings.Contains(asha.Body, "{{") {
		t.Fatalf("asha's drafts = %q / %q", asha.WhatsApp, asha.Body)
	}

	// The template not approved: refused before Meta is asked.
	r := h.followupSend(wb.ID, false, types.FollowupSendItem{Key: asha.Key, Channel: "whatsapp", Body: asha.WhatsApp})
	if r[0].Status != types.FollowupStatusSkipped || r[0].Reason != types.FollowupReasonTemplate {
		t.Fatalf("asha whatsapp before approval = %+v", r[0])
	}
	// No opt-in: refused, whatever the window.
	r = h.followupSend(wb.ID, false, types.FollowupSendItem{Key: bongi.Key, Channel: "whatsapp", Body: "Hi"})
	if r[0].Status != types.FollowupStatusSkipped || r[0].Reason != types.FollowupReasonNoOptIn {
		t.Fatalf("bongi whatsapp = %+v", r[0])
	}
	if n := len(g.sent()); n != sendsBefore {
		t.Fatalf("a refused follow-up reached Meta: %d sends", n-sendsBefore)
	}

	// Chen, inside the window: the text as it is, filed in his thread under the webinar.
	r = h.followupSend(wb.ID, false, types.FollowupSendItem{Key: chenR.Key, Channel: "whatsapp", Body: "Hi {{first_name}}, here is the replay."})
	if r[0].Status != types.FollowupStatusSent || r[0].Mode != types.FollowupModeFreeform {
		t.Fatalf("chen = %+v", r[0])
	}
	last := g.sent()[len(g.sent())-1]
	if last["type"] != "text" || last["text"].(map[string]any)["body"] != "Hi Chen, here is the replay." {
		t.Fatalf("chen's send = %+v", last)
	}
	thread := crmThread(t, h, chen.ID)
	if m := thread.Messages[len(thread.Messages)-1]; m.Direction != "out" || m.Body != "Hi Chen, here is the replay." {
		t.Fatalf("chen's thread ends with %+v", m)
	}
	// Twice is a dedupe, not a second message; "send again" is the way.
	r = h.followupSend(wb.ID, false, types.FollowupSendItem{Key: chenR.Key, Channel: "whatsapp", Body: "Hi again"})
	if r[0].Status != types.FollowupStatusSkipped || r[0].Reason != types.FollowupReasonAlreadySent {
		t.Fatalf("chen twice = %+v", r[0])
	}
	if p := h.followupPlan(wb.ID, []string{chenR.Key}); !p.Recipients[0].WAPlan.Sent {
		t.Fatalf("plan does not say chen had it: %+v", p.Recipients[0])
	}
	n := len(g.sent())
	r = h.followupSend(wb.ID, true, types.FollowupSendItem{Key: chenR.Key, Channel: "whatsapp", Body: "Hi again"})
	if r[0].Status != types.FollowupStatusSent || len(g.sent()) != n+1 {
		t.Fatalf("send again = %+v", r[0])
	}

	// Submitting our template, one click; once Meta approves, Asha gets it as a template.
	res, raw := h.do(http.MethodPost, "/api/host/crm/followup-template", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("submit template: %d %s", res.StatusCode, raw)
	}
	var tmpl types.FollowupTemplateResponse
	h.decode(raw, &tmpl)
	if tmpl.Status != "PENDING" || tmpl.Category != "MARKETING" || len(g.createdTemplates()) != 1 {
		t.Fatalf("template = %+v", tmpl)
	}
	g.approveAll()
	if p := h.followupPlan(wb.ID, []string{asha.Key}); p.TemplateStatus != "APPROVED" ||
		p.Recipients[0].WAPlan.Mode != types.FollowupModeTemplate {
		t.Fatalf("after approval = %+v", p)
	}
	r = h.followupSend(wb.ID, false, types.FollowupSendItem{Key: asha.Key, Channel: "whatsapp",
		Body: "Hi Asha,\nthanks for coming.\n\n\tThe replay is up.     See you!"})
	if r[0].Status != types.FollowupStatusSent || r[0].Mode != types.FollowupModeTemplate {
		t.Fatalf("asha template = %+v", r[0])
	}
	last = g.sent()[len(g.sent())-1]
	tp := last["template"].(map[string]any)
	if tp["name"] != types.FollowupTemplateName {
		t.Fatalf("template send = %+v", last)
	}
	params := tp["components"].([]any)[0].(map[string]any)["parameters"].([]any)
	third := params[2].(map[string]any)["text"].(string)
	if len(params) != 3 || params[0].(map[string]any)["text"] != "Asha" || params[1].(map[string]any)["text"] != "Money basics" ||
		third != "thanks for coming. The replay is up. See you!" {
		t.Fatalf("template params = %+v", params)
	}

	// Email to Bongi: in the host's name, Reply-To the host, an unsubscribe link, filed.
	r = h.followupSend(wb.ID, false, types.FollowupSendItem{Key: bongi.Key, Channel: "email", Subject: bongi.Subject, Body: bongi.Body})
	if r[0].Status != types.FollowupStatusSent {
		t.Fatalf("bongi email = %+v", r[0])
	}
	var sent notify.Message
	for _, m := range mail.sent {
		if m.To == "bongi@test.dev" {
			sent = m
		}
	}
	if sent.FromName != "Fola Host" || !strings.Contains(sent.ReplyTo, "fola@test.dev") || sent.ListUnsubscribe == "" ||
		!strings.Contains(sent.Body, sent.ListUnsubscribe) || sent.MessageID == "" || sent.Subject != bongi.Subject {
		t.Fatalf("email = %+v", sent)
	}
	var filed int
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM host_emails WHERE user_id = $1 AND direction = 'out' AND to_addr = 'bongi@test.dev' AND message_id = $2`,
		host.ID, sent.MessageID).Scan(&filed); err != nil || filed != 1 {
		t.Fatalf("filed emails = %d (%v)", filed, err)
	}

	// Bongi unsubscribes from the link; the next email to him is skipped.
	token := sent.ListUnsubscribe[strings.LastIndex(sent.ListUnsubscribe, "/")+1:]
	if res, _ := h.do(http.MethodGet, "/api/email/unsubscribe/"+token, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("unsubscribe page: %d", res.StatusCode)
	}
	if p := h.followupPlan(wb.ID, []string{bongi.Key}); !p.Recipients[0].EmailPlan.Available {
		t.Fatal("opening the page unsubscribed him")
	}
	if res, _ := h.do(http.MethodPost, "/api/email/unsubscribe/"+token, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("unsubscribe: %d", res.StatusCode)
	}
	if p := h.followupPlan(wb.ID, []string{bongi.Key}); p.Recipients[0].EmailPlan.Available ||
		p.Recipients[0].EmailPlan.Reason != types.FollowupReasonUnsubscribed {
		t.Fatalf("after unsubscribe = %+v", p.Recipients[0])
	}
	mails := len(mail.sent)
	r = h.followupSend(wb.ID, true, types.FollowupSendItem{Key: bongi.Key, Channel: "email", Subject: "Again", Body: "Hi"})
	if r[0].Status != types.FollowupStatusSkipped || r[0].Reason != types.FollowupReasonUnsubscribed || len(mail.sent) != mails {
		t.Fatalf("email after unsubscribe = %+v", r[0])
	}
	if res, _ := h.do(http.MethodPost, "/api/email/unsubscribe/not-a-token", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown token: %d", res.StatusCode)
	}

	// Somebody not in this session, and a channel that does not exist.
	r = h.followupSend(wb.ID, false,
		types.FollowupSendItem{Key: "00000000-0000-0000-0000-000000000000", Channel: "email", Subject: "x", Body: "x"},
		types.FollowupSendItem{Key: asha.Key, Channel: "sms", Body: "x"})
	if r[0].Reason != types.FollowupReasonNotInSession || r[1].Reason != types.FollowupReasonBadChannel {
		t.Fatalf("odd items = %+v", r)
	}

	// Another host gets nothing: not the plan, not a send.
	h.logout()
	h.signup("Other Host", "other-host@test.dev", true)
	for _, path := range []string{"/followups/plan", "/followups/send"} {
		res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+path, types.FollowupSendRequest{
			Items: []types.FollowupSendItem{{Key: asha.Key, Channel: "email", Subject: "x", Body: "x"}}})
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("other host %s: %d %s", path, res.StatusCode, raw)
		}
	}
}

func TestFollowupsCannotBeSentBeforeTheEnd(t *testing.T) {
	h, _ := aiHarness(t, followupsReply, nil)
	h.signup("Early Host", "early@test.dev", true)
	host, _ := h.store.UserByEmail(context.Background(), "early@test.dev")
	enableAIForUser(t, h, host.ID)
	wb := h.liveWebinar("Still live", nil)
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/followups/plan", types.FollowupPlanRequest{Keys: []string{"x"}})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("plan while live: %d %s", res.StatusCode, raw)
	}
}
