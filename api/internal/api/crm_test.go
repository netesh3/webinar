package api_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The lead CRM: where contacts come from, and who can see them.
 *
 * Three claims are worth proving and the last one is the one that would actually
 * hurt if it broke:
 *
 *  1. Registering puts somebody in the host's CRM, once, however many times they
 *     register — and consent is recorded as consent, not assumed.
 *  2. An inbound WhatsApp message lands on the contact who already registered
 *     rather than creating a second copy of the same person, and a redelivery of
 *     the same message does not duplicate it.
 *  3. None of it is visible to another host. These rows are strangers' phone
 *     numbers and the things they said in private to a business, and the webhook
 *     that writes them is driven by a payload from the internet rather than by a
 *     session.
 */

const crmContactPhone = "+27 83 111 2222"

// crmPhoneDigits is the same number as Meta writes it in a webhook: digits, no
// plus. Both spellings have to resolve to one contact, which is the whole reason
// the CRM normalises numbers the way registrations do.
const crmPhoneDigits = "27831112222"

// autoWebinar creates a webinar that registers people without an approval step,
// owned by the logged-in caller.
func autoWebinar(t *testing.T, h *harness, topic string) types.Webinar {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic":                topic,
		"startsAt":             soon(),
		"durationMin":          45,
		"status":               "scheduled",
		"registrationRequired": true,
		"approval":             "automatic",
		"attendeeLimit":        100,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}

// contactWithPhone picks one out of a list by number rather than by position: two
// contacts whose last message carries the same Meta timestamp have no meaningful
// order between them, and a test that depends on one is a test that fails later
// for no reason.
func contactWithPhone(t *testing.T, contacts []types.CRMContact, phone string) types.CRMContact {
	t.Helper()
	for _, c := range contacts {
		if c.Phone == phone {
			return c
		}
	}
	t.Fatalf("no contact with phone %s in %d contacts", phone, len(contacts))
	return types.CRMContact{}
}

func crmContacts(t *testing.T, h *harness) types.CRMContactsResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("contacts: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMContactsResponse
	h.decode(raw, &out)
	return out
}

// postWebhook signs a payload the way Meta does and posts it. Every ingest test
// goes through the real endpoint rather than the store, because the signature and
// the routing are part of what is being tested.
func postWebhook(t *testing.T, h *harness, body string) *http.Response {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(testMetaAppSecret))
	mac.Write([]byte(body))
	res, raw := h.doRaw(http.MethodPost, "/api/webhooks/whatsapp", "application/json", []byte(body),
		map[string]string{"X-Hub-Signature-256": "sha256=" + hex.EncodeToString(mac.Sum(nil))})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("webhook: status %d body %s", res.StatusCode, raw)
	}
	return res
}

// inboundPayload is one text message arriving on the host's number.
func inboundPayload(wamid, from, name, text string) string {
	return inboundPayloadOn(testMetaPhoneID, wamid, from, name, text)
}

// inboundPayloadOn is the same delivery on a chosen number, for the case where it
// is one nobody has connected.
func inboundPayloadOn(phoneNumberID, wamid, from, name, text string) string {
	return fmt.Sprintf(`{"object":"whatsapp_business_account","entry":[{"id":%q,
	  "changes":[{"field":"messages","value":{
	    "messaging_product":"whatsapp",
	    "metadata":{"display_phone_number":"27820000000","phone_number_id":%q},
	    "contacts":[{"profile":{"name":%q},"wa_id":%q}],
	    "messages":[{"from":%q,"id":%q,"timestamp":"1700000000","type":"text",
	                 "text":{"body":%q}}]}}]}]}`,
		testMetaWABAID, phoneNumberID, name, from, from, wamid, text)
}

func TestRegistrationBecomesOneCRMContact(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "CRM from registrations")

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Thandi", LastName: "Mokoena", Email: "thandi@example.com",
		Company: "Mokoena Studio", Phone: crmContactPhone, Consent: true,
		WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}

	list := crmContacts(t, h)
	if list.Total != 1 || len(list.Contacts) != 1 {
		t.Fatalf("total %d, %d contacts, want 1 of each", list.Total, len(list.Contacts))
	}
	c := list.Contacts[0]
	if c.Name != "Thandi Mokoena" || c.Email != "thandi@example.com" || c.Company != "Mokoena Studio" {
		t.Errorf("contact = %+v", c)
	}
	// Normalised to E.164 on the way in, the same as the registration's own number,
	// because a webhook's "27831112222" has to find this row.
	if c.Phone != "+"+crmPhoneDigits {
		t.Errorf("phone = %q, want +%s", c.Phone, crmPhoneDigits)
	}
	if !c.WhatsAppOptIn || c.WhatsAppOptInAt == "" {
		t.Errorf("opt-in not recorded: %+v", c)
	}
	if c.Source != "registration" {
		t.Errorf("source = %q", c.Source)
	}
	// The CRM works with WhatsApp disconnected — it just cannot send. Saying so is
	// what lets the UI explain an empty Send button instead of hiding the leads.
	if list.WhatsAppConnected {
		t.Error("whatsappConnected true with no grant stored")
	}

	// Registering again is idempotent on the registration, and must be idempotent
	// here too: one person, one contact, however many forms they submit.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Thandi", LastName: "Mokoena", Email: "thandi@example.com",
		Phone: crmContactPhone, Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("re-register: status %d body %s", res.StatusCode, raw)
	}
	if again := crmContacts(t, h); again.Total != 1 {
		t.Errorf("total %d after registering twice, want 1", again.Total)
	}
}

/* Consent needs something to apply to.
 *
 * Ticking "WhatsApp updates" on a form with no number in it is consent to nothing,
 * and storing it as an opt-in would put somebody in a broadcast audience that can
 * never reach them — while making the host's opt-in count a lie.
 */
func TestWhatsAppOptInNeedsANumber(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Opt-in without a number")

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Sam", Email: "sam@example.com", Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	list := crmContacts(t, h)
	if len(list.Contacts) != 1 {
		t.Fatalf("want the contact stored on email alone, got %d", len(list.Contacts))
	}
	if list.Contacts[0].WhatsAppOptIn || list.Contacts[0].WhatsAppOptInAt != "" {
		t.Errorf("opt-in recorded without a phone number: %+v", list.Contacts[0])
	}
}

// Every read is scoped to the caller's own account, and a contact id from another
// host's CRM is a 404 rather than anything at all.
func TestCRMIsScopedToTheHost(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Scoping")
	registerGuest(t, h, wb.ID, "scoped@example.com")

	mine := crmContacts(t, h)
	if len(mine.Contacts) != 1 {
		t.Fatalf("own CRM has %d contacts, want 1", len(mine.Contacts))
	}
	id := mine.Contacts[0].ID

	h.logout()
	h.login("lucia@cabify.com")
	if other := crmContacts(t, h); other.Total != 0 || len(other.Contacts) != 0 {
		t.Errorf("another host sees %d contacts", len(other.Contacts))
	}
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/api/host/crm/contacts/" + id},
		{http.MethodPost, "/api/host/crm/contacts/" + id + "/opt-out"},
	} {
		res, raw := h.do(r.method, r.path, nil)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s: status %d, want 404\n  body: %s", r.method, r.path, res.StatusCode, raw)
		}
	}

	// An attendee account has no CRM to read at all.
	h.logout()
	h.signup("Attendee", "attendee-crm@example.com", false)
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts", nil)
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("attendee: status %d, want 403\n  body: %s", res.StatusCode, raw)
	}
}

/* The ingest path, from a signed delivery to a thread.
 *
 * The assertion that matters most is the merge: somebody who registered and then
 * replied on WhatsApp is ONE contact. Two rows for the same person is how a host
 * ends up messaging them twice and seeing half the conversation in each.
 */
func TestWhatsAppWebhookIngestsIntoTheHostsCRM(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Inbound WhatsApp")

	// The same person, registered first with the number written the human way.
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Thandi", LastName: "Mokoena", Email: "thandi@example.com",
		Phone: crmContactPhone, Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	before := crmContacts(t, h)
	if len(before.Contacts) != 1 {
		t.Fatalf("want 1 contact from the registration, got %d", len(before.Contacts))
	}
	contactID := before.Contacts[0].ID

	// Connect the host's WhatsApp, which is what makes phone-1 route to them.
	res, raw = h.do(http.MethodPost, "/api/host/whatsapp/callback", types.WhatsAppCallbackRequest{
		Code: "code-from-dialog", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("connect: status %d body %s", res.StatusCode, raw)
	}

	body := inboundPayload("wamid.IN1", crmPhoneDigits, "T on WhatsApp", "Is the replay available?")
	postWebhook(t, h, body)

	after := crmContacts(t, h)
	if after.Total != 1 || len(after.Contacts) != 1 {
		t.Fatalf("total %d after an inbound message, want the registrant merged into one contact", after.Total)
	}
	c := after.Contacts[0]
	if c.ID != contactID {
		t.Errorf("contact id changed from %s to %s: the reply created a second copy of one person", contactID, c.ID)
	}
	/* The WhatsApp profile name is whatever somebody set on their phone. It fills a
	 * blank and never overwrites the name a registration form collected, or a host's
	 * list degrades every time a contact replies. */
	if c.Name != "Thandi Mokoena" {
		t.Errorf("name = %q, want the registration's name kept", c.Name)
	}
	if c.LastMessage == nil || c.LastMessage.Body != "Is the replay available?" {
		t.Fatalf("last message = %+v", c.LastMessage)
	}
	if c.LastMessage.Direction != "in" {
		t.Errorf("direction = %q, want in", c.LastMessage.Direction)
	}
	if c.LastSeenAt == "" {
		t.Error("lastSeenAt empty: an inbox cannot sort by who is waiting")
	}

	// The thread reads the conversation.
	res, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+contactID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("thread: status %d body %s", res.StatusCode, raw)
	}
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if thread.Contact.ID != contactID || len(thread.Messages) != 1 {
		t.Fatalf("thread = %d messages for contact %s", len(thread.Messages), thread.Contact.ID)
	}

	/* Meta retries any delivery it did not see a 2xx for, including ones we handled
	 * and then failed to acknowledge. Without idempotency on the message id, a
	 * webhook that works produces a thread with half the messages in it twice and no
	 * way for the host to tell which copy is real. */
	postWebhook(t, h, body)
	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+contactID, nil)
	var again types.CRMThreadResponse
	h.decode(raw, &again)
	if len(again.Messages) != 1 {
		t.Errorf("%d messages after a redelivery, want 1", len(again.Messages))
	}

	/* A delivery for one of OUR numbers from somebody who never registered is a new
	 * contact: writing to a business is how most of them will arrive once this is in
	 * front of real people. */
	postWebhook(t, h, inboundPayload("wamid.IN2", "27849998888", "Stranger", "hello?"))
	fresh := crmContacts(t, h)
	if fresh.Total != 2 {
		t.Fatalf("total %d, want the new sender added as a contact", fresh.Total)
	}
	// Not opted in, though. Replying to a business opens Meta's 24-hour service
	// window; it is not permission to put somebody in a marketing broadcast.
	newest := contactWithPhone(t, fresh.Contacts, "+27849998888")
	if newest.WhatsAppOptIn {
		t.Error("an inbound message was treated as marketing consent")
	}
	if newest.Source != "whatsapp" {
		t.Errorf("source = %q, want whatsapp", newest.Source)
	}

	/* A delivery on a number nobody has connected is acknowledged and dropped — the
	 * ordinary consequence of a host disconnecting while Meta still has traffic in
	 * flight, and the assertion that the routing is by number rather than by "the
	 * only host who has connected one". */
	postWebhook(t, h, inboundPayloadOn("phone-nobody-owns", "wamid.IN3", "27840001111", "Nobody", "hello?"))
	if unknown := crmContacts(t, h); unknown.Total != 2 {
		t.Errorf("total %d: a message on an unconnected number created a contact", unknown.Total)
	}
}

/* "STOP" is honoured on arrival rather than waiting for the broadcast feature.
 *
 * It is the word people use, Meta requires it to work, and the cost of deferring it
 * is a host continuing to message somebody who asked them not to.
 */
func TestWhatsAppStopOptsTheContactOut(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Stop means stop")

	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Thandi", Email: "thandi@example.com",
		Phone: crmContactPhone, Consent: true, WhatsAppOptIn: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	h.do(http.MethodPost, "/api/host/whatsapp/callback", types.WhatsAppCallbackRequest{
		Code: "c", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID,
	})

	// A sentence that merely contains the word is a request to a human, not an
	// unsubscribe: silently dropping this person would be worse than not matching.
	postWebhook(t, h, inboundPayload("wamid.S0", crmPhoneDigits, "T",
		"please stop sending the 9am one, the 5pm is fine"))
	if c := crmContacts(t, h).Contacts[0]; !c.WhatsAppOptIn {
		t.Fatalf("a request to a human was read as an unsubscribe: %+v", c)
	}

	postWebhook(t, h, inboundPayload("wamid.S1", crmPhoneDigits, "T", " Stop "))
	c := crmContacts(t, h).Contacts[0]
	if c.WhatsAppOptIn {
		t.Errorf("still opted in after STOP: %+v", c)
	}
	if c.WhatsAppOptOutAt == "" {
		t.Error("no opt-out timestamp: the refusal has to be provable, not merely applied")
	}
	// The message itself is kept. The host has to be able to see what was said.
	_, raw = h.do(http.MethodGet, "/api/host/crm/contacts/"+c.ID, nil)
	var thread types.CRMThreadResponse
	h.decode(raw, &thread)
	if len(thread.Messages) != 2 {
		t.Errorf("%d messages, want both kept", len(thread.Messages))
	}

	// And a host can record the same thing when they were told out of band.
	res, raw = h.do(http.MethodPost, "/api/host/crm/contacts/"+c.ID+"/opt-out", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("opt-out: status %d body %s", res.StatusCode, raw)
	}
	var updated types.CRMContact
	h.decode(raw, &updated)
	if updated.WhatsAppOptIn {
		t.Errorf("opt-out endpoint left the contact sendable: %+v", updated)
	}
	if updated.WhatsAppOptOutAt != c.WhatsAppOptOutAt {
		t.Errorf("opt-out date moved from %q to %q: the first refusal is the one that matters",
			c.WhatsAppOptOutAt, updated.WhatsAppOptOutAt)
	}
}

/* Delivery statuses only ever move forward.
 *
 * Meta does not promise the order its status webhooks arrive in, and a "sent" that
 * lands after the "read" it preceded would make a message somebody has already
 * answered look unacknowledged.
 *
 * Applied to an INBOUND message here because nothing in this phase can send one —
 * that is Phase 1c. The rank logic under test is the same either way, and the
 * alternative was leaving it unasserted until there was a send path to hang it on.
 */
func TestWhatsAppStatusesDoNotGoBackwards(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Status ordering")
	registerGuest(t, h, wb.ID, "status@example.com")
	h.do(http.MethodPost, "/api/host/whatsapp/callback", types.WhatsAppCallbackRequest{
		Code: "c", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID,
	})
	// registerGuest uses a different number from crmContactPhone, so this inbound
	// message is that same registrant replying.
	postWebhook(t, h, inboundPayload("wamid.ST1", "919876543210", "Guest", "hi"))

	status := func(wamid, state string) string {
		return fmt.Sprintf(`{"entry":[{"id":%q,"changes":[{"field":"messages","value":{
		  "metadata":{"phone_number_id":%q},
		  "statuses":[{"id":%q,"status":%q,"timestamp":"1700000100"}]}}]}]}`,
			testMetaWABAID, testMetaPhoneID, wamid, state)
	}
	current := func() string {
		list := crmContacts(t, h)
		if len(list.Contacts) == 0 || list.Contacts[0].LastMessage == nil {
			t.Fatal("no message to read a status from")
		}
		return list.Contacts[0].LastMessage.Status
	}

	// Arrived, so already delivered.
	if got := current(); got != "delivered" {
		t.Fatalf("inbound status = %q, want delivered", got)
	}
	postWebhook(t, h, status("wamid.ST1", "sent"))
	if got := current(); got != "delivered" {
		t.Errorf("status = %q after a late 'sent', want delivered", got)
	}
	postWebhook(t, h, status("wamid.ST1", "read"))
	if got := current(); got != "read" {
		t.Errorf("status = %q after 'read', want read", got)
	}
	// Failure always wins: it is the one status a host has to act on.
	postWebhook(t, h, `{"entry":[{"id":"`+testMetaWABAID+`","changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":"`+testMetaPhoneID+`"},
	  "statuses":[{"id":"wamid.ST1","status":"failed","timestamp":"1700000200",
	    "errors":[{"code":131042,"details":"There is no payment method on this account."}]}]}}]}]}`)
	list := crmContacts(t, h)
	last := list.Contacts[0].LastMessage
	if last.Status != "failed" {
		t.Errorf("status = %q, want failed", last.Status)
	}
	// Meta's own words, kept verbatim: only the host can fix their billing, and
	// only if they are told what is wrong.
	if last.Error == "" {
		t.Error("failure stored with no reason")
	}

	// A status for a message we never stored is not an error.
	postWebhook(t, h, status("wamid.NEVER-SEEN", "delivered"))
}
