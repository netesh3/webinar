package api_test

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Broadcasts: who gets one, who does not, and what a host is told about it.
 *
 * The send path is the reminders' send path, already tested — what is new here is a
 * host aiming a message at a set of people they cannot see individually, which makes
 * the counting as important as the sending. Two claims run through all of it:
 *
 *   - the audience a host approves is the audience that gets messaged. Frozen at
 *     creation, so the number in the response is a fact rather than an estimate.
 *   - and every one of those rows is re-asked for consent when it is actually sent.
 *     A broadcast scheduled on Monday and sent on Friday must notice somebody who
 *     replied STOP on Wednesday, so "already queued" is never a reason to send.
 *
 * Every refusal below also asserts that nothing reached Meta. A rule enforced after
 * the host has been charged for the send is not a rule.
 */

const (
	// Second and third numbers, distinct from crmContactPhone: an audience is only
	// interesting with more than one person in it, and contacts are matched by number.
	broadcastPhone2 = "+27 84 555 6666"
	broadcastDigit2 = "27845556666"
	broadcastPhone3 = "+27 84 777 8888"
)

// drainSeq keeps the throwaway registrations in drainWhatsAppOutbox from colliding
// with each other, since two registrations with one email are one registration.
var drainSeq atomic.Int64

/* drainWhatsAppOutbox makes the server sweep its WhatsApp outbox, once.
 *
 * Standing in for the 30-second ticker, which is what sends a broadcast: the request
 * that creates one deliberately queues and returns, because a four-thousand-person
 * list is four thousand Graph calls and nobody's browser should be holding them open.
 *
 * There is no endpoint for "sweep now" and there should not be, so this goes through
 * the one host action that flushes the outbox on its way out — a registration (see
 * contactFromRegistration). The registrant is email-only, so it adds a contact that
 * no audience can reach and queues nothing of its own.
 */
func drainWhatsAppOutbox(t *testing.T, h *harness, slug string) {
	t.Helper()
	n := drainSeq.Add(1)
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/register", types.RegisterRequest{
		FirstName: "Sweeper", Email: fmt.Sprintf("sweeper-%d@example.com", n), Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("drain: status %d body %s", res.StatusCode, raw)
	}
}

// registerWithPhone puts one contact in the host's CRM in a chosen consent state.
func registerWithPhone(t *testing.T, h *harness, slug, name, email, phone string, optIn bool) types.CRMContact {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/register", types.RegisterRequest{
		FirstName: name, Email: email, Phone: phone, Consent: true, WhatsAppOptIn: optIn,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: status %d body %s", email, res.StatusCode, raw)
	}
	for _, c := range crmContacts(t, h).Contacts {
		if c.Email == email {
			return c
		}
	}
	t.Fatalf("no contact for %s after registering", email)
	return types.CRMContact{}
}

func audiencePreview(t *testing.T, h *harness, query string) types.CRMAudienceResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/audience"+query, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("audience%s: status %d body %s", query, res.StatusCode, raw)
	}
	var out types.CRMAudienceResponse
	h.decode(raw, &out)
	return out
}

// createBroadcast posts one and expects it to be accepted.
func createBroadcast(t *testing.T, h *harness, body types.CRMBroadcastRequest) types.CRMBroadcast {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create broadcast: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMBroadcast
	h.decode(raw, &out)
	return out
}

func readBroadcast(t *testing.T, h *harness, id string) types.CRMBroadcast {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/broadcasts/"+id, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("read broadcast: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMBroadcast
	h.decode(raw, &out)
	return out
}

func threadFor(t *testing.T, h *harness, contactID string) types.CRMThreadResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts/"+contactID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("thread: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMThreadResponse
	h.decode(raw, &out)
	return out
}

/* The audience preview, and the three reasons somebody is not in it.
 *
 * The buckets are the feature, not the total. A host who reaches 1 of their 4
 * contacts is entitled to know that two of them have a number and never agreed to be
 * messaged on it — because that is the one they can do something about, by asking —
 * and to find that out before creating anything.
 */
func TestCRMAudienceCountsEveryReason(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Scaling Postgres")

	registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone2, false)
	optedOut := registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone3, true)
	registerWithPhone(t, h, wb.ID, "Lerato", "lerato@example.com", "", false)

	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+optedOut.ID+"/opt-out", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("opt out: status %d body %s", res.StatusCode, raw)
	}

	all := audiencePreview(t, h, "?audience=opted_in")
	if all.Recipients != 1 || all.NoOptIn != 1 || all.OptedOut != 1 || all.NoNumber != 1 {
		t.Fatalf("opted_in audience = %+v, want one person in each bucket", all)
	}
	if all.Audience != types.AudienceOptedIn {
		t.Errorf("audience echoed back as %q", all.Audience)
	}

	/* The same four people, reached through the webinar they registered for. Equal by
	 * construction here, and the point of asserting it is the matching: a contact's
	 * number is normalised and a registration keeps what was typed, so these only line
	 * up if the digits are compared rather than the strings. */
	byWebinar := audiencePreview(t, h, "?audience=webinar&webinarId="+wb.ID)
	if byWebinar != (types.CRMAudienceResponse{
		Audience: types.AudienceWebinar, Recipients: 1, NoOptIn: 1, OptedOut: 1, NoNumber: 1,
	}) {
		t.Fatalf("webinar audience = %+v, want the same four people", byWebinar)
	}

	// A second webinar nobody from the first registered for narrows it, while the
	// host-wide list grows: the two audiences are genuinely different questions.
	other := autoWebinar(t, h, "Another session")
	registerWithPhone(t, h, other.ID, "Kirsten", "kirsten@example.com", "+27 84 999 0000", true)

	if got := audiencePreview(t, h, "?audience=webinar&webinarId="+other.ID); got.Recipients != 1 || got.NoOptIn != 0 {
		t.Errorf("second webinar's audience = %+v, want only its own registrant", got)
	}
	if got := audiencePreview(t, h, "?audience=opted_in"); got.Recipients != 2 {
		t.Errorf("opted_in recipients = %d, want both opted-in contacts", got.Recipients)
	}

	// And the refusals, which are about the question rather than the answer.
	for _, tc := range []struct{ name, query, code string }{
		{"no audience at all", "", "crm_bad_audience"},
		{"an audience that does not exist", "?audience=everyone", "crm_bad_audience"},
		{"a webinar audience with no webinar", "?audience=webinar", "crm_no_webinar"},
		{"a webinar that does not exist", "?audience=webinar&webinarId=nope", "crm_no_webinar"},
	} {
		res, raw := h.do(http.MethodGet, "/api/host/crm/audience"+tc.query, nil)
		if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != tc.code {
			t.Errorf("%s: status %d code %q, want 422 %s\n  body: %s",
				tc.name, res.StatusCode, errorCode(t, raw), tc.code, raw)
		}
	}

	/* Another host's webinar reads as one that does not exist. Worth its own case:
	 * the slug is the only part of a broadcast that names somebody else's row, and a
	 * topic and a registrant count are exactly what a slug guesser would be after. */
	h.logout()
	h.login("lucia@cabify.com")
	res, raw = h.do(http.MethodGet, "/api/host/crm/audience?audience=webinar&webinarId="+wb.ID, nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_no_webinar" {
		t.Fatalf("another host's webinar: status %d code %q body %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
}

/* A broadcast, end to end: queued by the request, sent by the sweeper, counted from
 * both halves of what happened.
 *
 * The assertion that creating one sends NOTHING is as important as the one that the
 * sweeper sends it. A host pressing Send is not asking for their browser to hold a
 * connection open while a thousand messages go out one at a time.
 */
func TestCRMBroadcastQueuesResolvesAndSends(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Scaling Postgres")

	thandi := registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	ayanda := registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)
	registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone3, false)

	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name:      "Doors open",
		Template:  testTemplateUtility,
		Language:  "en_US",
		Params:    []types.CRMParam{{Field: "name"}},
		Audience:  types.AudienceWebinar,
		WebinarID: wb.ID,
	})
	if b.Stats.Recipients != 2 || b.Stats.Queued != 2 {
		t.Fatalf("stats = %+v, want the two opted-in registrants queued: Sam gave a number "+
			"and never agreed to be messaged on it", b.Stats)
	}
	if b.Status != "scheduled" {
		t.Errorf("status = %q before the sweep, want scheduled", b.Status)
	}
	if b.Name != "Doors open" || b.Template != testTemplateUtility || b.WebinarTopic != "Scaling Postgres" {
		t.Errorf("broadcast = %+v", b)
	}
	// Stored as configured, unresolved: the broadcast has to read back as the host
	// wrote it, not as one recipient received it.
	if len(b.Params) != 1 || b.Params[0].Field != "name" {
		t.Errorf("params = %+v, want the merge token kept", b.Params)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Fatalf("%d messages reached Meta from the request that created the broadcast: %v\n"+
			"  queueing is the whole point — a long list must not be sent inline", len(sends), sends)
	}

	drainWhatsAppOutbox(t, h, wb.ID)

	sent := readBroadcast(t, h, b.ID)
	if sent.Status != "sent" || sent.Stats.Sent != 2 || sent.Stats.Queued != 0 || sent.Stats.Failed != 0 {
		t.Fatalf("after the sweep: status %q stats %+v", sent.Status, sent.Stats)
	}
	sends := g.sent()
	if len(sends) != 2 {
		t.Fatalf("%d sends reached Meta, want one per recipient: %v", len(sends), sends)
	}
	to := map[any]bool{sends[0]["to"]: true, sends[1]["to"]: true}
	if !to[crmPhoneDigits] || !to[broadcastDigit2] {
		t.Errorf("sent to %v, want both opted-in numbers", to)
	}
	for i, s := range sends {
		if s["type"] != "template" {
			t.Errorf("send %d type = %v, want template: nobody in a broadcast has written in, "+
				"so the 24-hour window has never opened", i, s["type"])
		}
	}

	/* Resolved per recipient, which is visible where it matters: each person's own
	 * thread holds the words they actually read. One rendering for the whole list
	 * would have been the easy bug, and "Hi there" to everybody the symptom. */
	if got := threadFor(t, h, thandi.ID); len(got.Messages) != 1 ||
		got.Messages[0].Body != "Hi Thandi, your webinar starts in an hour." {
		t.Errorf("Thandi's thread = %+v", got.Messages)
	}
	if got := threadFor(t, h, ayanda.ID); len(got.Messages) != 1 ||
		got.Messages[0].Body != "Hi Ayanda, your webinar starts in an hour." {
		t.Errorf("Ayanda's thread = %+v", got.Messages)
	}

	/* Delivered and read arrive later, by webhook, about messages Meta had already
	 * accepted — and they are counted against the broadcast that caused them. Without
	 * this the stats could only ever say "sent", which is the least interesting of the
	 * things a host wants to know. */
	for _, st := range []struct{ wamid, status string }{
		{"wamid.OUT1", "delivered"},
		{"wamid.OUT2", "read"},
	} {
		postWebhook(t, h, `{"entry":[{"id":"`+testMetaWABAID+`","changes":[{"field":"messages","value":{
		  "metadata":{"phone_number_id":"`+testMetaPhoneID+`"},
		  "statuses":[{"id":"`+st.wamid+`","status":"`+st.status+`","timestamp":"1700000300"}]}}]}]}`)
	}
	reported := readBroadcast(t, h, b.ID)
	if reported.Stats.Delivered != 2 || reported.Stats.Read != 1 {
		t.Errorf("stats = %+v, want both delivered and one of them read: a read message has "+
			"been delivered too, so read is a subset", reported.Stats)
	}
	if reported.Stats.Sent != 2 {
		t.Errorf("sent = %d after the reports, want it to stay 2", reported.Stats.Sent)
	}

	// And it is in the list, with its stats, which is the screen a host actually looks at.
	res, raw := h.do(http.MethodGet, "/api/host/crm/broadcasts", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: status %d body %s", res.StatusCode, raw)
	}
	var list types.CRMBroadcastsResponse
	h.decode(raw, &list)
	if len(list.Broadcasts) != 1 || list.Broadcasts[0].ID != b.ID {
		t.Fatalf("list = %+v", list.Broadcasts)
	}
	if list.Broadcasts[0].Stats.Read != 1 || !list.WhatsAppConnected || len(list.Fields) == 0 {
		t.Errorf("list response = %+v", list)
	}
}

/* Consent is asked again when the message is actually sent.
 *
 * The case the whole design is arranged around: a broadcast is a list of queued rows,
 * and somebody on that list can withdraw between the scheduling and the sending. The
 * row must not go out, and — the part that is easy to get wrong — it must not be
 * marked as anything either, because an opt-out is not permanent and a row retired on
 * a Tuesday cannot come back.
 */
func TestCRMBroadcastRechecksConsentBeforeSending(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Second thoughts")

	registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	leaving := registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)

	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Launch", Template: testTemplateMarketing, Language: "en_US",
		Audience: types.AudienceOptedIn,
	})
	if b.Stats.Recipients != 2 {
		t.Fatalf("recipients = %d, want both opted-in contacts", b.Stats.Recipients)
	}

	// After the audience was frozen and before a single message went out.
	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+leaving.ID+"/opt-out", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("opt out: status %d body %s", res.StatusCode, raw)
	}

	drainWhatsAppOutbox(t, h, wb.ID)

	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("%d sends reached Meta, want only the contact who still wants them: %v", len(sends), sends)
	}
	if sends[0]["to"] != crmPhoneDigits {
		t.Errorf("sent to %v, want the contact who did not opt out", sends[0]["to"])
	}
	if got := threadFor(t, h, leaving.ID); len(got.Messages) != 0 {
		t.Errorf("the contact who opted out has %d messages: %+v", len(got.Messages), got.Messages)
	}

	/* One sent, one still pending — so the broadcast reads as "sending" rather than
	 * finished, and honestly so: nothing has decided that this person will never be
	 * messaged. They can opt back in and the row is still there. */
	after := readBroadcast(t, h, b.ID)
	if after.Stats.Sent != 1 || after.Stats.Queued != 1 || after.Stats.Skipped != 0 {
		t.Fatalf("stats = %+v, want one sent and one still waiting on a consent that "+
			"might come back", after.Stats)
	}
	if after.Status != "sending" {
		t.Errorf("status = %q, want sending while a row is still pending", after.Status)
	}
}

/* Cancelling stops what is left and lies about nothing.
 *
 * There is no unsend on WhatsApp, so the two things this has to get right are that
 * the queued rows stop and that the sent ones stay counted — and that a host who
 * cancels a broadcast which has already finished is told so rather than thanked.
 */
func TestCRMBroadcastCancelRetiresWhatIsLeft(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Called off")

	registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone2, true)

	b := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Next week", Template: testTemplateMarketing, Language: "en_US",
		Audience:    types.AudienceOptedIn,
		ScheduledAt: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
	})
	if b.Status != "scheduled" || b.Stats.Queued != 2 {
		t.Fatalf("broadcast = %q %+v, want two messages waiting for their time", b.Status, b.Stats)
	}

	res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts/"+b.ID+"/cancel", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("cancel: status %d body %s", res.StatusCode, raw)
	}
	var cancelled types.CRMBroadcast
	h.decode(raw, &cancelled)
	if cancelled.Status != "cancelled" || cancelled.Stats.Skipped != 2 || cancelled.Stats.Queued != 0 {
		t.Fatalf("after cancel: status %q stats %+v", cancelled.Status, cancelled.Stats)
	}

	// The rows are retired rather than merely un-due, so no later sweep finds them.
	drainWhatsAppOutbox(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d messages went out after the broadcast was cancelled: %v", len(sends), sends)
	}

	// Cancelling it again has nothing to stop, and says so.
	res, raw = h.do(http.MethodPost, "/api/host/crm/broadcasts/"+b.ID+"/cancel", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_broadcast_done" {
		t.Errorf("second cancel: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}

	/* And a broadcast that has already gone out cannot be cancelled either — the one
	 * refusal worth being firm about, because "cancelled" on a message people have
	 * already read is the single thing a host cannot check for themselves. */
	done := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Already gone", Template: testTemplateMarketing, Language: "en_US",
		Audience: types.AudienceOptedIn,
	})
	drainWhatsAppOutbox(t, h, wb.ID)
	if got := readBroadcast(t, h, done.ID); got.Stats.Sent != 2 {
		t.Fatalf("stats = %+v, want both sent before cancelling is tried", got.Stats)
	}
	res, raw = h.do(http.MethodPost, "/api/host/crm/broadcasts/"+done.ID+"/cancel", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_broadcast_done" {
		t.Errorf("cancel a finished broadcast: status %d code %q body %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
}

/* Every way of composing a broadcast that would fail later, refused now.
 *
 * The moment a host presses Send is the only moment somebody is present to be told.
 * A broadcast whose {{2}} is blank, or which names a template Meta has not approved,
 * discovers it once per recipient otherwise — and the host pays for the attempts.
 *
 * This host has no opted-in contacts at all, which is why the last case is a request
 * with nothing wrong with it: the audience is resolved after everything else, so the
 * earlier refusals are unaffected by there being nobody to send to.
 */
func TestCRMBroadcastRefusals(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))

	// Somebody else's webinar, made first so the cases below have a slug to aim at.
	h.login("lucia@cabify.com")
	stranger := autoWebinar(t, h, "Not yours")
	h.logout()

	h.login("neeraj@acme.dev")
	wb := autoWebinar(t, h, "Refusing to broadcast")
	registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone2, false)

	// Before connecting, nothing can be queued by anybody: there is no token to bill.
	res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", types.CRMBroadcastRequest{
		Template: testTemplateMarketing, Language: "en_US", Audience: types.AudienceOptedIn,
	})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_not_connected" {
		t.Fatalf("not connected: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}
	connectWhatsApp(t, h)

	cases := []struct {
		name string
		body types.CRMBroadcastRequest
		code string
		why  string
	}{
		{
			name: "no audience", code: "crm_bad_audience",
			body: types.CRMBroadcastRequest{Template: testTemplateMarketing, Language: "en_US"},
			why:  "an unrecognised audience could only be resolved by guessing who was meant",
		},
		{
			name: "a webinar audience with no webinar", code: "crm_no_webinar",
			body: types.CRMBroadcastRequest{
				Template: testTemplateMarketing, Language: "en_US", Audience: types.AudienceWebinar,
			},
			why: "the audience is the registrants of a webinar nobody named",
		},
		{
			name: "somebody else's webinar", code: "crm_no_webinar",
			body: types.CRMBroadcastRequest{
				Template: testTemplateMarketing, Language: "en_US",
				Audience: types.AudienceWebinar, WebinarID: stranger.ID,
			},
			why: "another host's registrants are strangers' phone numbers",
		},
		{
			name: "a template Meta has not approved", code: "crm_template_unusable",
			body: types.CRMBroadcastRequest{
				Template: testTemplatePending, Language: "en_US", Audience: types.AudienceOptedIn,
			},
			why: "Meta refuses it once per recipient, and charges for the attempt",
		},
		{
			name: "a template that is not in the account", code: "crm_no_template",
			body: types.CRMBroadcastRequest{
				Template: "invented_by_the_ui", Language: "en_US", Audience: types.AudienceOptedIn,
			},
			why: "there is no default and no inventing one",
		},
		{
			name: "too few values", code: "crm_template_params",
			body: types.CRMBroadcastRequest{
				Template: testTemplateUtility, Language: "en_US", Audience: types.AudienceOptedIn,
			},
			why: "the {{n}} count has to match exactly or Meta rejects the send",
		},
		{
			name: "too many values", code: "crm_template_params",
			body: types.CRMBroadcastRequest{
				Template: testTemplateUtility, Language: "en_US", Audience: types.AudienceOptedIn,
				Params: []types.CRMParam{{Text: "one"}, {Text: "two"}},
			},
			why: "the {{n}} count has to match exactly or Meta rejects the send",
		},
		{
			name: "a merge field that does not exist", code: "crm_bad_merge_field",
			body: types.CRMBroadcastRequest{
				Template: testTemplateUtility, Language: "en_US", Audience: types.AudienceOptedIn,
				Params: []types.CRMParam{{Field: "surname"}},
			},
			why: "nothing would fill it in, for anybody",
		},
		{
			name: "the webinar merge fields with no webinar", code: "crm_no_webinar",
			body: types.CRMBroadcastRequest{
				Template: testTemplateUtility, Language: "en_US", Audience: types.AudienceOptedIn,
				Params: []types.CRMParam{{Field: "topic"}},
			},
			why: "a broadcast about no webinar has no topic, and would read \"— starts soon\"",
		},
		{
			name: "a value that is only whitespace", code: "crm_bad_param",
			body: types.CRMBroadcastRequest{
				Template: testTemplateUtility, Language: "en_US", Audience: types.AudienceOptedIn,
				Params: []types.CRMParam{{Text: "   "}},
			},
			why: "Meta rejects a blank parameter, and rejects the whole message with it",
		},
		{
			name: "a send time that is not a time", code: "crm_bad_schedule",
			body: types.CRMBroadcastRequest{
				Template: testTemplateMarketing, Language: "en_US", Audience: types.AudienceOptedIn,
				ScheduledAt: "tomorrow-ish",
			},
			why: "a schedule nobody can read is a broadcast that goes out at the wrong time",
		},
		{
			name: "nobody has opted in", code: "crm_audience_empty",
			body: types.CRMBroadcastRequest{
				Template: testTemplateMarketing, Language: "en_US", Audience: types.AudienceOptedIn,
			},
			why: "an empty broadcast reads as \"it worked\", and one of those two readings is false",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, raw := h.do(http.MethodPost, "/api/host/crm/broadcasts", tc.body)
			if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != tc.code {
				t.Fatalf("status %d code %q, want 422 %s\n  %s\n  body: %s",
					res.StatusCode, errorCode(t, raw), tc.code, tc.why, raw)
			}
		})
	}

	// Nothing was created by any of them, and nothing reached Meta.
	res, raw = h.do(http.MethodGet, "/api/host/crm/broadcasts", nil)
	var list types.CRMBroadcastsResponse
	h.decode(raw, &list)
	if len(list.Broadcasts) != 0 {
		t.Errorf("%d broadcasts exist after only refusals: %+v", len(list.Broadcasts), list.Broadcasts)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d messages reached Meta during the refusals: %v", len(sends), sends)
	}
}

/* A broadcast belongs to the host who sent it, and to nobody else.
 *
 * The stakes are the same as for the contacts it was sent to: the list is who a
 * competitor's leads are, and the cancel endpoint would be a way to stop somebody
 * else's launch.
 */
func TestCRMBroadcastsAreHostScoped(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := autoWebinar(t, h, "Mine")
	registerWithPhone(t, h, wb.ID, "Thandi", "thandi@example.com", crmContactPhone, true)

	mine := createBroadcast(t, h, types.CRMBroadcastRequest{
		Name: "Mine", Template: testTemplateMarketing, Language: "en_US",
		Audience:    types.AudienceOptedIn,
		ScheduledAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
	})

	h.logout()
	h.login("lucia@cabify.com")

	_, raw := h.do(http.MethodGet, "/api/host/crm/broadcasts", nil)
	var list types.CRMBroadcastsResponse
	h.decode(raw, &list)
	if len(list.Broadcasts) != 0 {
		t.Errorf("another host sees %+v", list.Broadcasts)
	}
	if list.WhatsAppConnected {
		t.Error("whatsappConnected true for a host who has connected nothing")
	}

	for _, tc := range []struct{ name, method, path string }{
		{"read", http.MethodGet, "/api/host/crm/broadcasts/" + mine.ID},
		{"cancel", http.MethodPost, "/api/host/crm/broadcasts/" + mine.ID + "/cancel"},
	} {
		res, raw := h.do(tc.method, tc.path, nil)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s another host's broadcast: status %d body %s", tc.name, res.StatusCode, raw)
		}
	}

	// And it is untouched: still scheduled, still owed to the people it was aimed at.
	h.logout()
	h.login("neeraj@acme.dev")
	if got := readBroadcast(t, h, mine.ID); got.Status != "scheduled" || got.Stats.Queued != 1 {
		t.Errorf("after another host tried to cancel it: status %q stats %+v", got.Status, got.Stats)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d messages went out: %v", len(sends), sends)
	}
}
