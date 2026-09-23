package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The automatic WhatsApp messages.
 *
 * Three independent switches decide whether a registrant hears from a host on
 * WhatsApp — the host's chosen template, the webinar's toggle, the contact's opt-in
 * — and the tests below are mostly about each of them being able to stop the send on
 * its own. That is the shape the feature has to have: the cost of a false positive
 * is a message on a stranger's phone billed to the host's account, and no amount of
 * the other two switches being on makes a missing opt-in acceptable.
 *
 * The outbox is read through the store rather than an endpoint, because a 24-hour
 * reminder is not due for a day and the only honest way to assert it was queued is
 * to look at the row.
 */

// remindersWebinar creates a webinar far enough ahead that BOTH timed reminders are
// still in the future, with WhatsApp messaging switched on. `soon()` is five minutes
// out, which would correctly skip a "starts in 24 hours" message and make every
// assertion below a coincidence.
func remindersWebinar(t *testing.T, h *harness, topic string, whatsapp bool) types.Webinar {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic":                topic,
		"startsAt":             time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin":          45,
		"status":               "scheduled",
		"registrationRequired": true,
		"approval":             "automatic",
		"attendeeLimit":        100,
		"options":              map[string]any{"whatsappReminders": whatsapp},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if wb.Options.WhatsAppReminders != whatsapp {
		t.Fatalf("whatsappReminders = %v, want %v — the rest of this test would prove nothing",
			wb.Options.WhatsAppReminders, whatsapp)
	}
	return wb
}

// setReminders configures the host's automatic messages and expects it to be accepted.
func setReminders(t *testing.T, h *harness, in ...types.CRMReminder) types.CRMRemindersResponse {
	t.Helper()
	res, raw := h.do(http.MethodPut, "/api/host/crm/reminders",
		types.CRMRemindersRequest{Reminders: in})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("set reminders: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMRemindersResponse
	h.decode(raw, &out)
	return out
}

func reminderFor(t *testing.T, out types.CRMRemindersResponse, kind types.NotificationKind) types.CRMReminder {
	t.Helper()
	for _, r := range out.Reminders {
		if r.Kind == kind {
			return r
		}
	}
	t.Fatalf("no %s in %+v", kind, out.Reminders)
	return types.CRMReminder{}
}

/* The settings, and every way of configuring something that would fail later.
 *
 * All of these are checked when a host presses save rather than when a message is
 * due, because that is the only moment somebody is present to be told. A reminder
 * that names an unapproved template otherwise discovers it at 3am the day before a
 * webinar, with nobody watching and nothing sent.
 */
func TestCRMReminderSettings(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")

	// Nothing configured yet, and every kind is still listed: the settings screen
	// renders the same three rows before and after.
	res, raw := h.do(http.MethodGet, "/api/host/crm/reminders", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reminders: status %d body %s", res.StatusCode, raw)
	}
	var empty types.CRMRemindersResponse
	h.decode(raw, &empty)
	if len(empty.Reminders) != len(types.WhatsAppReminderKinds) {
		t.Fatalf("reminders = %+v, want one entry per kind", empty.Reminders)
	}
	if empty.Reminders[0].Kind != types.NotifyWhatsAppConfirmed {
		t.Errorf("first kind = %q, want the confirmation: the list is in the order the "+
			"messages reach somebody", empty.Reminders[0].Kind)
	}
	if empty.WhatsAppConnected {
		t.Error("whatsappConnected true before connecting")
	}
	if len(empty.Fields) == 0 {
		t.Error("no merge fields offered; the picker would have nothing to fill {{1}} with")
	}

	// A template cannot be chosen before there is an account to read templates from.
	res, raw = h.do(http.MethodPut, "/api/host/crm/reminders", types.CRMRemindersRequest{
		Reminders: []types.CRMReminder{{
			Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"name"},
		}},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_not_connected" {
		t.Fatalf("before connecting: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}

	connectWhatsApp(t, h)

	refusals := []struct {
		name string
		in   types.CRMReminder
		code string
	}{
		{
			name: "a kind that does not exist",
			in: types.CRMReminder{
				Kind: "wa_birthday", Template: testTemplateUtility,
				Language: "en_US", Params: []string{"name"},
			},
			code: "crm_bad_kind",
		},
		{
			// An email kind is a real NotificationKind and still not something this
			// endpoint may write: the row it would produce has no template at all.
			name: "an email kind",
			in: types.CRMReminder{
				Kind: types.NotifyReminder1h, Template: testTemplateUtility,
				Language: "en_US", Params: []string{"name"},
			},
			code: "crm_bad_kind",
		},
		{
			name: "a template Meta has not approved",
			in: types.CRMReminder{
				Kind: types.NotifyWhatsAppConfirmed, Template: testTemplatePending,
				Language: "en_US",
			},
			code: "crm_template_unusable",
		},
		{
			name: "a template nobody has",
			in: types.CRMReminder{
				Kind: types.NotifyWhatsAppConfirmed, Template: "invented_template",
				Language: "en_US",
			},
			code: "crm_no_template",
		},
		{
			/* Meta rejects a send whose parameter count does not match the approved
			 * template, so a reminder configured this way is one that never arrives. */
			name: "too few values for the template's placeholders",
			in: types.CRMReminder{
				Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
				Language: "en_US",
			},
			code: "crm_template_params",
		},
		{
			name: "more values than the template has placeholders",
			in: types.CRMReminder{
				Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
				Language: "en_US", Params: []string{"name", "topic"},
			},
			code: "crm_template_params",
		},
		{
			/* A fact this application cannot produce at send time. Refused rather than
			 * substituted with a blank, because Meta rejects an empty parameter — one
			 * invented token would lose every message that used it. */
			name: "a merge field that is not a fact we have",
			in: types.CRMReminder{
				Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
				Language: "en_US", Params: []string{"discount_code"},
			},
			code: "crm_bad_merge_field",
		},
	}
	for _, tc := range refusals {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.do(http.MethodPut, "/api/host/crm/reminders",
				types.CRMRemindersRequest{Reminders: []types.CRMReminder{tc.in}})
			if res.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("status %d, want 422\n  body: %s", res.StatusCode, raw)
			}
			if code := errorCode(t, raw); code != tc.code {
				t.Errorf("code = %q, want %q\n  body: %s", code, tc.code, raw)
			}
		})
	}

	// Nothing above may have been saved: a refused save is not a partial one.
	if got := reminderFor(t, empty, types.NotifyWhatsAppConfirmed); got.Template != "" {
		t.Errorf("confirmation = %+v after only refusals", got)
	}

	out := setReminders(t, h,
		types.CRMReminder{
			Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"name"},
		},
		types.CRMReminder{
			Kind: types.NotifyWhatsAppReminder1h, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"topic"},
		},
	)
	if got := reminderFor(t, out, types.NotifyWhatsAppConfirmed); got.Template != testTemplateUtility ||
		len(got.Params) != 1 || got.Params[0] != "name" {
		t.Errorf("confirmation = %+v", got)
	}
	// Untouched kinds stay off rather than inheriting another kind's template:
	// "you're registered" and "starting in 24 hours" are not the same sentence.
	if got := reminderFor(t, out, types.NotifyWhatsAppReminder24h); got.Template != "" {
		t.Errorf("24h = %+v, want off", got)
	}

	// And it survives the round trip, because a setting that only exists in one
	// response is not a setting.
	_, raw = h.do(http.MethodGet, "/api/host/crm/reminders", nil)
	var reread types.CRMRemindersResponse
	h.decode(raw, &reread)
	if got := reminderFor(t, reread, types.NotifyWhatsAppReminder1h); got.Params[0] != "topic" {
		t.Errorf("1h after re-reading = %+v", got)
	}

	/* Switching one off is naming no template, and it must not disturb the others.
	 * A replace rather than a patch is what makes "off" expressible at all. */
	out = setReminders(t, h,
		types.CRMReminder{Kind: types.NotifyWhatsAppConfirmed, Template: ""},
		types.CRMReminder{
			Kind: types.NotifyWhatsAppReminder1h, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"topic"},
		},
	)
	if got := reminderFor(t, out, types.NotifyWhatsAppConfirmed); got.Template != "" {
		t.Errorf("confirmation = %+v after being cleared", got)
	}
	if got := reminderFor(t, out, types.NotifyWhatsAppReminder1h); got.Template != testTemplateUtility {
		t.Errorf("1h = %+v, want it left alone", got)
	}

	// Another host's settings are their own, and start empty.
	h.logout()
	h.login("lucia@cabify.com")
	_, raw = h.do(http.MethodGet, "/api/host/crm/reminders", nil)
	var other types.CRMRemindersResponse
	h.decode(raw, &other)
	if got := reminderFor(t, other, types.NotifyWhatsAppReminder1h); got.Template != "" {
		t.Errorf("another host sees %+v", got)
	}
}

/* Registering sends the confirmation and queues the reminders.
 *
 * The end-to-end claim of the feature: somebody fills in a form with a phone number
 * and a ticked box, and a message billed to the host's own WhatsApp account arrives
 * — rendered with this person's name, filed in the host's inbox, and with the id
 * Meta's delivery reports will carry.
 */
func TestWhatsAppConfirmationOnRegistration(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h,
		types.CRMReminder{
			Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"name"},
		},
		types.CRMReminder{
			Kind: types.NotifyWhatsAppReminder24h, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"topic"},
		},
		types.CRMReminder{
			Kind: types.NotifyWhatsAppReminder1h, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"when"},
		},
	)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	contact := registerOptedIn(t, h, wb.ID)

	// The confirmation went out during the registration rather than on the next tick
	// of the sweeper: a "you're registered" message half a minute late reads as a
	// system that is not sure.
	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("%d sends reached Meta on registration, want exactly the confirmation: %v",
			len(sends), sends)
	}
	if sends[0]["to"] != crmPhoneDigits {
		t.Errorf("to = %v, want %s", sends[0]["to"], crmPhoneDigits)
	}
	if sends[0]["type"] != "template" {
		t.Errorf("type = %v, want template: nobody has written in, so the 24-hour window "+
			"has never opened", sends[0]["type"])
	}

	// And it is in the host's inbox, rendered, so the next reply has a conversation
	// to sit in.
	_, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if len(thread.Messages) != 1 {
		t.Fatalf("thread = %+v, want the confirmation", thread.Messages)
	}
	msg := thread.Messages[0]
	if msg.Direction != "out" || msg.Status != "sent" || msg.TemplateName != testTemplateUtility {
		t.Errorf("message = %+v", msg)
	}
	if msg.Body != "Hi Thandi Mokoena, your webinar starts in an hour." {
		t.Errorf("body = %q, want the template rendered with this contact's name", msg.Body)
	}
	/* The id Meta returned was stored, which is asserted the only way it is visible:
	 * a delivery report naming it finds the row. Without it, an automatic message
	 * could never be shown as delivered, read or failed — and "did they get it" is
	 * the question a host asks about a reminder. */
	postWebhook(t, h, `{"entry":[{"id":"`+testMetaWABAID+`","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"`+testMetaPhoneID+`"},
	  "statuses":[{"id":"wamid.OUT1","status":"read","timestamp":"1700000300"}]}}]}]}`)
	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+contact.ID, nil)
	h.decode(raw, &thread)
	if got := thread.Messages[0].Status; got != "read" {
		t.Errorf("status = %q after Meta's report, want read", got)
	}

	/* The timed reminders are queued and NOT sent: they are a day and an hour before
	 * a webinar that is two days out. Moving the webinar to now is how the outbox is
	 * inspected without waiting — and rescheduling is a real host action, so the same
	 * call proves the WhatsApp rows move with it. */
	ctx := context.Background()
	starts := time.Now().Add(-2 * time.Minute)
	if err := h.store.RescheduleRemindersForWebinar(ctx, wb.ID, starts); err != nil {
		t.Fatalf("reschedule: %v", err)
	}
	owed, err := h.store.PendingWhatsApp(ctx, 10)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(owed) != 2 {
		t.Fatalf("%d messages owed, want the 24h and 1h reminders: %+v", len(owed), owed)
	}
	byKind := map[string][]string{}
	for _, m := range owed {
		byKind[m.Kind] = m.Params
		if m.Token != testMetaHostToken || m.PhoneNumberID != testMetaPhoneID {
			t.Errorf("%s would be sent with %q/%q, not the host's own credentials",
				m.Kind, m.Token, m.PhoneNumberID)
		}
	}
	/* Resolved when the row was written, not when it is sent. The row is a record of
	 * what was promised: a webinar renamed an hour before it starts must not silently
	 * rewrite a message somebody is about to receive. */
	if got := byKind[string(types.NotifyWhatsAppReminder24h)]; len(got) != 1 || got[0] != "Scaling Postgres" {
		t.Errorf("24h params = %v, want the webinar's topic", got)
	}
	if got := byKind[string(types.NotifyWhatsAppReminder1h)]; len(got) != 1 || got[0] == "" {
		t.Errorf("1h params = %v, want the start time; Meta rejects a blank parameter", got)
	}
}

/* Each switch on its own is enough to send nothing.
 *
 * One test per switch would share so much setup that the interesting line would be
 * hard to find; what matters is that each case ends with an empty outbox and an
 * untouched Meta, for a different reason.
 */
func TestWhatsAppRemindersNeedAllThreeSwitches(t *testing.T) {
	cases := []struct {
		name     string
		toggle   bool
		optIn    bool
		template bool
		why      string
	}{
		{
			name: "the webinar's toggle is off", toggle: false, optIn: true, template: true,
			why: "every message is charged to the host's own Meta account, so a webinar " +
				"they did not switch on must not spend it — not even for a confirmation",
		},
		{
			name: "the contact never opted in", toggle: true, optIn: false, template: true,
			why: "a phone number on a form is not permission to message it, and the tick " +
				"box beside it is the only thing that is",
		},
		{
			name: "the host has chosen no template", toggle: true, optIn: true, template: false,
			why: "there is no default: Meta only delivers templates it has approved, so a " +
				"name this application invented would be a rejection rather than a message",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newFakeGraph(t)
			h := newHarness(t, whatsappConfigured(g.srv.URL))
			h.login("neeraj@acme.dev")
			connectWhatsApp(t, h)
			if tc.template {
				setReminders(t, h, types.CRMReminder{
					Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
					Language: "en_US", Params: []string{"name"},
				})
			}
			wb := remindersWebinar(t, h, "Switched off", tc.toggle)

			res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
				FirstName: "Thandi", Email: "thandi@example.com",
				Phone: crmContactPhone, Consent: true, WhatsAppOptIn: tc.optIn,
			})
			if res.StatusCode != http.StatusCreated {
				t.Fatalf("register: status %d body %s", res.StatusCode, raw)
			}

			if sends := g.sent(); len(sends) != 0 {
				t.Errorf("%d messages reached Meta: %v\n  %s", len(sends), sends, tc.why)
			}
			// And nothing is waiting either: a row queued now is a message sent the
			// moment the condition changes, which for an opt-in that never happened
			// would be a surprise weeks later.
			owed, err := h.store.PendingWhatsApp(context.Background(), 10)
			if err != nil {
				t.Fatalf("pending: %v", err)
			}
			if len(owed) != 0 {
				t.Errorf("%d messages owed: %+v\n  %s", len(owed), owed, tc.why)
			}
		})
	}
}

/* A seat that needs approving holds its confirmation, and a template that has
 * disappeared retires it.
 *
 * Both halves are about the gap between queueing a message and sending it. A
 * pending registrant must not be told they are registered before their host has
 * decided; and a template can be paused or deleted at Meta in the meantime, which
 * has to end as a skipped row with a reason rather than a charge for a message
 * nobody receives.
 */
func TestWhatsAppConfirmationWaitsForApproval(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"name"},
	})

	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Approval first", "startsAt": time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 45, "status": "scheduled", "registrationRequired": true,
		"approval": "manual", "attendeeLimit": 100,
		"options": map[string]any{"whatsappReminders": true},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Thandi", Email: "thandi@example.com",
		Phone: crmContactPhone, Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Fatalf("a pending registrant was told they are registered: %v", sends)
	}
	// Queued, though: the host's decision is what releases it, and no second hook on
	// the approval path is needed to make that happen.
	owed, err := h.store.PendingWhatsApp(context.Background(), 10)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(owed) != 0 {
		t.Errorf("%d messages sendable while the seat is still pending: %+v", len(owed), owed)
	}

	/* Meta loses the template before the host approves, which is the case this
	 * re-check exists for: paused, deleted or edited between queueing and sending. */
	g.setTemplates(defaultFakeTemplates()[1:])
	crmTemplates(t, h, "?refresh=1")

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{
			IDs:   []string{idOf(t, h, wb.ID, "thandi@example.com")},
			State: types.RegApproved,
		})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approve: status %d body %s", res.StatusCode, raw)
	}

	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d sends for a template Meta no longer has: %v", len(sends), sends)
	}
	// Retired rather than retried: the reason is on the row, and a message naming a
	// template that is gone cannot become sendable by waiting.
	owed, err = h.store.PendingWhatsApp(context.Background(), 10)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(owed) != 0 {
		t.Errorf("%d messages still owed after the template vanished: %+v", len(owed), owed)
	}
	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+
		contactWithPhone(t, crmContacts(t, h).Contacts, "+"+crmPhoneDigits).ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if len(thread.Messages) != 0 {
		t.Errorf("thread = %+v, want nothing: no message was sent", thread.Messages)
	}
}

/* An opt-out after the reminder was queued stops it.
 *
 * The one that matters most, because the row was written when the answer was yes.
 * A reminder in the outbox is a promise about the future, and "stop" has to outrank
 * it — a message sent after somebody asked not to be messaged is the failure this
 * whole consent model exists to prevent.
 */
func TestWhatsAppReminderStopsOnOptOut(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReminder1h, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"name"},
	})
	wb := remindersWebinar(t, h, "Opting out in between", true)
	contact := registerOptedIn(t, h, wb.ID)

	ctx := context.Background()
	if err := h.store.RescheduleRemindersForWebinar(ctx, wb.ID, time.Now()); err != nil {
		t.Fatalf("reschedule: %v", err)
	}
	owed, err := h.store.PendingWhatsApp(ctx, 10)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(owed) != 1 {
		t.Fatalf("%d messages owed before the opt-out, want the 1h reminder: %+v", len(owed), owed)
	}

	// "Stop", however it arrives — here through the host's own inbox control.
	if res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+contact.ID+"/opt-out", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("opt-out: status %d body %s", res.StatusCode, raw)
	}

	owed, err = h.store.PendingWhatsApp(ctx, 10)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(owed) != 0 {
		t.Errorf("%d messages still owed to somebody who asked not to be messaged: %+v",
			len(owed), owed)
	}

	/* And disconnecting WhatsApp stops everything too, for a different reason: there
	 * is no token to bill and no number to send from. The settings are kept, which is
	 * what makes reconnecting painless. */
	if res, raw := h.do(http.MethodDelete, "/api/host/whatsapp", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("disconnect: status %d body %s", res.StatusCode, raw)
	}
	_, raw := h.do(http.MethodGet, "/api/host/crm/reminders", nil)
	var after types.CRMRemindersResponse
	h.decode(raw, &after)
	if got := reminderFor(t, after, types.NotifyWhatsAppReminder1h); got.Template != testTemplateUtility {
		t.Errorf("1h = %+v after disconnecting, want the setting kept", got)
	}
	if after.WhatsAppConnected {
		t.Error("whatsappConnected true after disconnecting")
	}
}
