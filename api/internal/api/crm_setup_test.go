package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The setup checklist: what is left to do before WhatsApp sends anything.
 *
 * The feature has seven steps and three of them fail in silence, which is why this
 * endpoint exists and why the test walks the whole path in order rather than checking
 * each step from a fixture. The claims worth the file:
 *
 *  1. Every step reads as undone before it is done and done after — including the two
 *     nothing else in the product surfaces: a number that is connected but not
 *     registered, and a webinar whose WhatsApp switch is off.
 *  2. Registering the number is a step only for accounts the switch is on for. A
 *     checklist that counts a step with no button is a checklist a host cannot finish.
 *  3. A reminder whose template Meta has stopped approving is reported as BROKEN, not
 *     as set and not as unset. That state is invisible everywhere else: the send is
 *     skipped without an error, so the setting looks finished and nothing arrives.
 *  4. Reading the checklist never calls Meta. It is read on arrival at the CRM, and a
 *     rate-limited Graph round trip on every visit is a cost with no step behind it.
 *  5. The "who can I reach" number is the broadcast audience's own number. Two ways of
 *     counting it is how a checklist ends up disagreeing with the send screen.
 */

func crmSetup(t *testing.T, h *harness) types.CRMSetup {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/setup", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("setup: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMSetup
	h.decode(raw, &out)
	return out
}

func TestCRMSetupTracksEachStep(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	const host = "neeraj@acme.dev"
	h.login(host)

	/* Step 0: a host who has done nothing, and the one number that must be right even
	 * then — RemindersTotal. The screen renders "0 of N", so an N of zero would read as
	 * a finished checklist for somebody who has not started. */
	fresh := crmSetup(t, h)
	if fresh.Connected || fresh.DisplayPhone != "" || fresh.VerifiedName != "" {
		t.Errorf("a fresh account reads as connected: %+v", fresh)
	}
	if fresh.RemindersTotal != len(types.WhatsAppReminderKinds) {
		t.Errorf("remindersTotal = %d, want one per kind (%d)",
			fresh.RemindersTotal, len(types.WhatsAppReminderKinds))
	}
	if fresh.Templates != 0 || fresh.SendableTemplates != 0 || fresh.TemplatesSyncedAt != "" ||
		fresh.RemindersSet != 0 || len(fresh.RemindersBroken) != 0 ||
		fresh.WebinarsWithReminders != 0 || fresh.OptedInContacts != 0 {
		t.Errorf("a fresh account has work already done: %+v", fresh)
	}
	/* The seeded account already owns webinars, so the webinar step is counted from
	 * where it starts rather than from zero — which is also the honest shape of the
	 * assertion for a real host, who reaches this screen with a back catalogue. */
	baseWebinars := fresh.WebinarsTotal

	/* Registering the number is not this host's step until an admin says so.
	 *
	 * Read from the same switch that decides whether the form is rendered, so the
	 * count and the buttons cannot disagree. */
	if fresh.RegisterStep {
		t.Error("registerStep true without the whatsapp_register switch: " +
			"the checklist would count a step with no button")
	}
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhatsAppRegister)
	if s := crmSetup(t, h); !s.RegisterStep || s.RegisteredAt != "" {
		t.Errorf("after the switch: registerStep %v, registeredAt %q, want true and undone",
			s.RegisterStep, s.RegisteredAt)
	}

	// Step 1: connect. The number and the business name come with it, because the
	// checklist has to be able to say WHICH number it is talking about.
	connectWhatsApp(t, h)
	connected := crmSetup(t, h)
	if !connected.Connected || connected.DisplayPhone != testMetaDisplay ||
		connected.VerifiedName != testMetaBusinessNm {
		t.Errorf("after connecting: %+v", connected)
	}

	/* Reading the checklist did not ask Meta for templates, and still says none.
	 *
	 * Three reads of the checklist so far and the count is exactly zero: arriving at the
	 * CRM must not spend a rate-limited Graph call on a step the host is about to press
	 * a button for anyway. */
	if g.syncs() != 0 {
		t.Errorf("the checklist called Meta %d times; it must read the cache only", g.syncs())
	}
	if connected.Templates != 0 {
		t.Errorf("templates = %d before any sync, want 0", connected.Templates)
	}

	// Step 2: register the number for sending.
	res, raw := h.do(http.MethodPost, "/api/host/whatsapp/register",
		types.WhatsAppRegisterRequest{Pin: testRegisterPin})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	if s := crmSetup(t, h); s.RegisteredAt == "" {
		t.Errorf("registeredAt still empty after registering: %+v", s)
	}

	/* Step 3: templates. Three cached, two of them sendable — the PENDING one is
	 * cached and cannot be sent, which is exactly the pair of numbers a host with
	 * "templates, and nothing to send" needs to see side by side. */
	crmTemplates(t, h, "")
	synced := crmSetup(t, h)
	if synced.Templates != 3 || synced.SendableTemplates != 2 {
		t.Errorf("templates %d of which sendable %d, want 3 and 2",
			synced.Templates, synced.SendableTemplates)
	}
	if synced.TemplatesSyncedAt == "" {
		t.Error("templatesSyncedAt empty after a sync: the host cannot tell how stale the list is")
	}

	// Step 4: choose a template for one automatic message.
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"name"},
	})
	if s := crmSetup(t, h); s.RemindersSet != 1 || len(s.RemindersBroken) != 0 {
		t.Errorf("after choosing one template: set %d broken %v, want 1 and none",
			s.RemindersSet, s.RemindersBroken)
	}

	/* Meta pauses that template, and the reminder is now neither set nor unset.
	 *
	 * The state the product is worst at revealing: the queue skips the send without an
	 * error, so from the host's side the setting still looks done. Counting it as set
	 * would hide it; counting it as unset would hide that they already did the work. */
	paused := defaultFakeTemplates()
	for _, tmpl := range paused {
		if tmpl["name"] == testTemplateUtility {
			tmpl["status"] = "PAUSED"
		}
	}
	g.setTemplates(paused)
	crmTemplates(t, h, "?refresh=1")
	broke := crmSetup(t, h)
	if broke.RemindersSet != 0 || len(broke.RemindersBroken) != 1 ||
		broke.RemindersBroken[0] != types.NotifyWhatsAppConfirmed {
		t.Errorf("with the template paused: set %d broken %v, want 0 and [%s]",
			broke.RemindersSet, broke.RemindersBroken, types.NotifyWhatsAppConfirmed)
	}
	// Meta approves it again and the reminder goes back to set, with nothing re-saved:
	// the host never broke it, so they must not have to fix it.
	g.setTemplates(defaultFakeTemplates())
	crmTemplates(t, h, "?refresh=1")
	if s := crmSetup(t, h); s.RemindersSet != 1 || len(s.RemindersBroken) != 0 {
		t.Errorf("after Meta re-approves: set %d broken %v", s.RemindersSet, s.RemindersBroken)
	}

	/* Step 5: the per-webinar switch, which defaults to off on purpose — every message
	 * is charged to the host's own Meta account — and which nothing else in the product
	 * mentions. So the checklist states it rather than turning it on. */
	remindersWebinar(t, h, "Off by default", false)
	if s := crmSetup(t, h); s.WebinarsTotal != baseWebinars+1 || s.WebinarsWithReminders != 0 {
		t.Errorf("one more webinar with the switch off: %d of %d have reminders, want 0 of %d",
			s.WebinarsWithReminders, s.WebinarsTotal, baseWebinars+1)
	}
	wb := remindersWebinar(t, h, "Switched on", true)
	if s := crmSetup(t, h); s.WebinarsTotal != baseWebinars+2 || s.WebinarsWithReminders != 1 {
		t.Errorf("second webinar switched on: %d of %d, want 1 of %d",
			s.WebinarsWithReminders, s.WebinarsTotal, baseWebinars+2)
	}

	/* And who all of it can actually reach, which has to be the broadcast audience's
	 * own count. The host reads one of these before spending money and the other while
	 * setting up; two different numbers for "people I can message" would make both
	 * screens untrustworthy. */
	registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", crmContactPhone, true)
	h.login(host)
	registerWithPhone(t, h, wb.ID, "Bheki", "bheki@example.com", broadcastPhone2, false)
	h.login(host)

	done := crmSetup(t, h)
	audience := audiencePreview(t, h, "?audience=opted_in")
	if done.OptedInContacts != 1 || done.OptedInContacts != audience.Recipients {
		t.Errorf("optedInContacts = %d, broadcast audience = %d, want 1 and the same number",
			done.OptedInContacts, audience.Recipients)
	}
}

/* The checklist belongs to one host, and is not readable without a session.
 *
 * It names the host's number, their business name and how many strangers' numbers they
 * hold — a second host's answer must be their own empty one, not this one's progress.
 */
func TestCRMSetupIsPerHostAndPrivate(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	if s := crmSetup(t, h); !s.Connected {
		t.Fatalf("setup: %+v — the rest of this test would prove nothing", s)
	}

	h.logout()
	h.login("lucia@cabify.com")
	if s := crmSetup(t, h); s.Connected || s.DisplayPhone != "" {
		t.Errorf("another host reads the first one's connection: %+v", s)
	}

	h.logout()
	res, raw := h.do(http.MethodGet, "/api/host/crm/setup", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("signed out: status %d body %s, want 401", res.StatusCode, raw)
	}
}
