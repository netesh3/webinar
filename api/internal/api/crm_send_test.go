package api_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Sending, and — mostly — not sending.
 *
 * The send path is short; the refusals in front of it are the feature. Each one
 * has to be proved separately because each is a different promise to a different
 * party: to the contact, that a refusal is honoured and that marketing needs a
 * yes; to Meta, that free-form text stays inside the 24-hour window and that only
 * approved templates leave; and to the host, that a message Meta charged them for
 * is in the thread with an id that later delivery reports can find.
 *
 * Every refusal also asserts that NOTHING reached Meta. A rule enforced after the
 * send has already been paid for is not a rule.
 */

// connectWhatsApp completes the callback the Embedded Signup dialog would have
// finished, which is what makes the host's number route and their sends billable.
func connectWhatsApp(t *testing.T, h *harness) {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/whatsapp/callback", types.WhatsAppCallbackRequest{
		Code: "code-from-dialog", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("connect: status %d body %s", res.StatusCode, raw)
	}
}

func crmTemplates(t *testing.T, h *harness, query string) types.CRMTemplatesResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/templates"+query, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("templates%s: status %d body %s", query, res.StatusCode, raw)
	}
	var out types.CRMTemplatesResponse
	h.decode(raw, &out)
	return out
}

func templateNamed(t *testing.T, list []types.CRMTemplate, name string) types.CRMTemplate {
	t.Helper()
	for _, tmpl := range list {
		if tmpl.Name == name {
			return tmpl
		}
	}
	t.Fatalf("no template %q in %d templates", name, len(list))
	return types.CRMTemplate{}
}

// registerOptedIn puts one opted-in contact with a WhatsApp number in the host's
// CRM, which is the starting state for every send worth making.
func registerOptedIn(t *testing.T, h *harness, webinarID string) types.CRMContact {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+webinarID+"/register", types.RegisterRequest{
		FirstName: "Thandi", LastName: "Mokoena", Email: "thandi@example.com",
		Phone: crmContactPhone, Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	return contactWithPhone(t, crmContacts(t, h).Contacts, "+"+crmPhoneDigits)
}

/* The cache is the point: Meta rate-limits template reads per WABA, and a
 * reminder that fails because a picker was opened twice would be absurd.
 */
func TestCRMTemplatesCachedAndRefreshed(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	first := crmTemplates(t, h, "")
	if g.syncs() != 1 {
		t.Fatalf("%d syncs on the first read, want 1: an empty cache has to fill itself", g.syncs())
	}
	if len(first.Templates) != 3 || first.SyncedAt == "" {
		t.Fatalf("templates = %+v, syncedAt = %q", first.Templates, first.SyncedAt)
	}
	if !first.WhatsAppConnected {
		t.Error("whatsappConnected false right after connecting")
	}

	utility := templateNamed(t, first.Templates, testTemplateUtility)
	if utility.Variables != 1 || !utility.Sendable || utility.Category != "UTILITY" {
		t.Errorf("utility template = %+v, want one variable and sendable", utility)
	}
	// Meta has not approved it, so it is listed and not offered — a host needs to
	// see that what they submitted is still waiting rather than missing.
	if pending := templateNamed(t, first.Templates, testTemplatePending); pending.Sendable {
		t.Errorf("a PENDING template was offered as sendable: %+v", pending)
	}

	// The second read is the whole reason for the table.
	crmTemplates(t, h, "")
	if g.syncs() != 1 {
		t.Errorf("%d syncs after a second read, want 1: the cache was not used", g.syncs())
	}

	/* An explicit refresh asks Meta again, and a template deleted there disappears
	 * here. A stale row is worse than a missing one: it offers a host a send that
	 * Meta will refuse. */
	g.setTemplates(defaultFakeTemplates()[:1])
	after := crmTemplates(t, h, "?refresh=1")
	if g.syncs() != 2 {
		t.Errorf("%d syncs after refresh=1, want 2", g.syncs())
	}
	if len(after.Templates) != 1 || after.Templates[0].Name != testTemplateUtility {
		t.Errorf("templates after refresh = %+v, want only the one Meta still has", after.Templates)
	}
}

/* A send that works, end to end: Meta is called with the host's own token, the
 * rendered text is filed in the thread, and the message id Meta returned is what a
 * later delivery report finds.
 */
func TestCRMSendTemplateRecordsTheMessage(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Sending a template")
	contact := registerOptedIn(t, h, wb.ID)
	connectWhatsApp(t, h)

	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/send",
		types.CRMSendRequest{
			Template: testTemplateUtility,
			Language: "en_US",
			Params:   []string{"Thandi"},
		})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("send: status %d body %s", res.StatusCode, raw)
	}
	var msg types.CRMMessage
	h.decode(raw, &msg)

	if msg.Direction != "out" || msg.Status != "sent" {
		t.Errorf("message = %+v, want an outbound send", msg)
	}
	if msg.TemplateName != testTemplateUtility {
		t.Errorf("templateName = %q", msg.TemplateName)
	}
	/* The rendered text, not the template with its placeholders in it: the thread is
	 * a record of what this person actually read. */
	if msg.Body != "Hi Thandi, your webinar starts in an hour." {
		t.Errorf("body = %q, want the template rendered with the parameter", msg.Body)
	}

	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("%d sends reached Meta, want 1", len(sends))
	}
	if sends[0]["to"] != crmPhoneDigits {
		t.Errorf("to = %v, want %s", sends[0]["to"], crmPhoneDigits)
	}

	// In the thread, where the host will look for it.
	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if len(thread.Messages) != 1 || thread.Messages[0].Direction != "out" {
		t.Fatalf("thread = %+v", thread.Messages)
	}

	/* And the id Meta returned is the one its delivery reports carry. Without it
	 * stored, an outbound message could never be shown as delivered, read or failed
	 * — which is the whole reason the send returns an id at all. */
	postWebhook(t, h, `{"entry":[{"id":"`+testMetaWABAID+`","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"`+testMetaPhoneID+`"},
	  "statuses":[{"id":"wamid.OUT1","status":"delivered","timestamp":"1700000300"}]}}]}]}`)
	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	h.decode(raw, &thread)
	if got := thread.Messages[0].Status; got != "delivered" {
		t.Errorf("status = %q after Meta's delivery report, want delivered", got)
	}
}

/* The refusals, each with the words a host can act on, and none of them reaching
 * Meta.
 */
func TestCRMSendRefusals(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Refusing to send")
	contact := registerOptedIn(t, h, wb.ID)

	// Before connecting, nothing can be sent by anybody — and the message says which
	// of the three possible problems it is.
	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/send",
		types.CRMSendRequest{Template: testTemplateUtility, Language: "en_US", Params: []string{"T"}})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_not_connected" {
		t.Fatalf("not connected: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}

	connectWhatsApp(t, h)

	// An email-only lead, and a contact who has asked not to be messaged.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Sam", Email: "sam@example.com", Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register email-only: status %d body %s", res.StatusCode, raw)
	}
	emailOnly := contactWithPhone(t, crmContacts(t, h).Contacts, "")

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Ayanda", Email: "ayanda@example.com", Phone: "+27 84 555 6666",
		Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register opted-out: status %d body %s", res.StatusCode, raw)
	}
	optedOut := contactWithPhone(t, crmContacts(t, h).Contacts, "+27845556666")
	if res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+optedOut.ID+"/opt-out", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("opt-out: status %d body %s", res.StatusCode, raw)
	}

	// Somebody with a number who never agreed to anything: the ordinary state of
	// most of a list.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Noluthando", Email: "nolu@example.com", Phone: "+27 84 777 8888",
		Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register no opt-in: status %d body %s", res.StatusCode, raw)
	}
	noOptIn := contactWithPhone(t, crmContacts(t, h).Contacts, "+27847778888")

	cases := []struct {
		name      string
		contactID string
		body      types.CRMSendRequest
		code      string
	}{
		{
			name: "no number to send to", contactID: emailOnly.ID, code: "crm_no_number",
			body: types.CRMSendRequest{Template: testTemplateUtility, Language: "en_US", Params: []string{"S"}},
		},
		{
			/* A refusal outranks every category. Somebody who said stop does not get a
			 * "utility" message about a webinar either — that reading would make the
			 * category the loophole that empties the whole consent model. */
			name: "opted out, even for a utility template", contactID: optedOut.ID, code: "crm_opted_out",
			body: types.CRMSendRequest{Template: testTemplateUtility, Language: "en_US", Params: []string{"A"}},
		},
		{
			/* Ours, not Meta's, and the line the opt-in box on the registration form
			 * exists to draw: marketing is the message they did not ask for. */
			name: "marketing without an opt-in", contactID: noOptIn.ID, code: "crm_no_opt_in",
			body: types.CRMSendRequest{Template: testTemplateMarketing, Language: "en_US"},
		},
		{
			name: "a template Meta has not approved", contactID: contact.ID, code: "crm_template_unusable",
			body: types.CRMSendRequest{Template: testTemplatePending, Language: "en_US"},
		},
		{
			// Meta rejects a mismatch rather than leaving a blank, so it is caught
			// before the send rather than reported after it.
			name: "the wrong number of values", contactID: contact.ID, code: "crm_template_params",
			body: types.CRMSendRequest{Template: testTemplateUtility, Language: "en_US"},
		},
		{
			// The same name in a language this host has not had approved.
			name: "a language that is not approved", contactID: contact.ID, code: "crm_no_template",
			body: types.CRMSendRequest{Template: testTemplateUtility, Language: "af", Params: []string{"T"}},
		},
		{
			name: "a template nobody has", contactID: contact.ID, code: "crm_no_template",
			body: types.CRMSendRequest{Template: "invented_template", Language: "en_US"},
		},
		{
			/* Free-form text with no inbound message: Meta's window has never opened.
			 * Refused here rather than sent and bounced, so the host still has what they
			 * typed and is told to pick a template. */
			name: "typed text outside the 24-hour window", contactID: contact.ID, code: "crm_window_closed",
			body: types.CRMSendRequest{Body: "Hi Thandi, quick question"},
		},
		{
			name: "both a message and a template", contactID: contact.ID, code: "crm_send_empty",
			body: types.CRMSendRequest{Body: "hello", Template: testTemplateUtility, Language: "en_US"},
		},
		{
			name: "neither", contactID: contact.ID, code: "crm_send_empty",
			body: types.CRMSendRequest{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+tc.contactID+"/send", tc.body)
			if res.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("status %d, want 422\n  body: %s", res.StatusCode, raw)
			}
			if code := errorCode(t, raw); code != tc.code {
				t.Errorf("code = %q, want %q\n  body: %s", code, tc.code, raw)
			}
		})
	}

	/* Nothing above may have reached Meta. A rule enforced after the send has been
	 * charged for is not a rule — and a marketing message delivered to somebody who
	 * never opted in cannot be recalled. */
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d sends reached Meta despite every request being refused: %v", len(sends), sends)
	}

	// And another host's contact id is a 404, not a refusal that confirms it exists.
	h.logout()
	h.login("lucia@cabify.com")
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/send",
		types.CRMSendRequest{Template: testTemplateUtility, Language: "en_US", Params: []string{"T"}})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("another host's contact: status %d, want 404\n  body: %s", res.StatusCode, raw)
	}
}

/* Free-form text is allowed because the contact opened the window, and for no
 * other reason.
 *
 * Asserted against somebody who has never opted in to anything: replying to a
 * person who just wrote to the business is exactly what the service window is for,
 * and requiring a marketing opt-in before answering a question would be absurd —
 * while sending them a marketing template on the strength of that same reply is
 * precisely what the opt-in rule forbids.
 */
func TestCRMFreeFormNeedsTheServiceWindow(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	/* A message that arrived just now, unlike the fixed timestamp the ingest tests
	 * use: the window is 24 hours from the contact's last message, so a 2023 fixture
	 * would prove the opposite of what this test is for. */
	postWebhook(t, h, strings.Replace(
		inboundPayload("wamid.WIN1", "27849998888", "Stranger", "Is there a replay?"),
		`"timestamp":"1700000000"`, `"timestamp":"`+strconv.FormatInt(time.Now().Unix(), 10)+`"`, 1))
	contact := contactWithPhone(t, crmContacts(t, h).Contacts, "+27849998888")
	if contact.WhatsAppOptIn {
		t.Fatal("an inbound message was read as consent")
	}

	// The thread says how long the window has left, so the compose box can offer
	// typing at all — and it is the server's clock, not the browser's.
	_, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if thread.ServiceWindowUntil == "" {
		t.Fatal("serviceWindowUntil empty after an inbound message")
	}
	if !thread.WhatsAppConnected {
		t.Error("whatsappConnected false in the thread with a grant stored")
	}

	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/send",
		types.CRMSendRequest{Body: "  Yes — I'll send it tomorrow.  "})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reply: status %d body %s", res.StatusCode, raw)
	}
	var msg types.CRMMessage
	h.decode(raw, &msg)
	if msg.Body != "Yes — I'll send it tomorrow." || msg.TemplateName != "" {
		t.Errorf("message = %+v, want the typed text with no template", msg)
	}
	sends := g.sent()
	if len(sends) != 1 || sends[0]["type"] != "text" {
		t.Fatalf("sends = %v, want one text message", sends)
	}

	// A marketing template to the same person is still refused. The window lets a
	// business answer; it does not let it advertise.
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/send",
		types.CRMSendRequest{Template: testTemplateMarketing, Language: "en_US"})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_no_opt_in" {
		t.Errorf("marketing inside the window: status %d code %q", res.StatusCode, errorCode(t, raw))
	}
}

/* When Meta refuses a send, the host is told what Meta said.
 *
 * The common causes are all things only they can fix — no payment method on the
 * WABA, a number not registered, a template paused an hour ago — and paraphrasing
 * any of them into "sending failed" removes the only useful part. Nothing is filed
 * in the thread either: the message was not delivered, and a queued row nobody
 * will ever update is worse than no row.
 */
func TestCRMSendReportsMetasReason(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Meta refuses")
	contact := registerOptedIn(t, h, wb.ID)
	connectWhatsApp(t, h)

	g.failSends(http.StatusBadRequest, map[string]any{
		"code": 131042, "message": "There is no payment method on this account.",
	})
	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/send",
		types.CRMSendRequest{Template: testTemplateUtility, Language: "en_US", Params: []string{"Thandi"}})
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502\n  body: %s", res.StatusCode, raw)
	}
	if code := errorCode(t, raw); code != "whatsapp_send_failed" {
		t.Errorf("code = %q, want whatsapp_send_failed", code)
	}
	if !strings.Contains(string(raw), "no payment method") {
		t.Errorf("Meta's reason was dropped: %s", raw)
	}

	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if len(thread.Messages) != 0 {
		t.Errorf("%d messages filed for a send Meta refused", len(thread.Messages))
	}
}
