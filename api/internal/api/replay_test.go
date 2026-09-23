package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Publishing a recording tells the people who registered for it.
 *
 * The gap this closes is worth stating, because it is what the tests are checking for:
 * before this, a host recorded a session, published the replay, and had no way to tell
 * the four hundred people whose addresses were already sitting in the product. So the
 * claims are that publishing queues one message per approved registrant, on two channels
 * with different rules, once per person however many times the switch is flipped — and
 * that it still works for a webinar that is over, which every other queued message in
 * this application deliberately does not.
 *
 * Asserted through store.PendingDeliveries and store.PendingWhatsApp rather than by
 * counting rows, because those two queries are what a message actually has to survive:
 * both of them filter out notifications for an ended webinar, and the replay is the one
 * kind that must pass. A test that read the table directly would pass while every real
 * replay was silently dropped a second later.
 */

// readyRecording records a webinar from start to finish and returns the recording.
func readyRecording(t *testing.T, h *harness, slug string) types.Recording {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings",
		types.StartRecordingRequest{Mime: `video/webm;codecs="vp9,opus"`})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: status %d body %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)

	path := "/api/host/webinars/" + slug + "/recordings/" + rec.ID
	if res, raw := h.doRaw(http.MethodPost, path+"/chunks",
		"application/octet-stream", []byte("a-recording-of-something"), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("chunk: status %d body %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPost, path+"/complete?durationMs=8000", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("complete: status %d body %s", res.StatusCode, raw)
	}
	return rec
}

// publishRecording is the host flipping the share switch, which is the trigger.
func publishRecording(t *testing.T, h *harness, slug, recID string, public bool) types.Recording {
	t.Helper()
	res, raw := h.do(http.MethodPatch,
		"/api/host/webinars/"+slug+"/recordings/"+recID+"/share",
		types.ShareRecordingRequest{IsPublic: ptr(public)})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("share(%v): status %d body %s", public, res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	return rec
}

/* replayEmails is the replay mail waiting to go out, and nothing else.
 *
 * Filtered by subject because the outbox is shared: each of these registrants also has a
 * confirmation sitting in it, and a test that counted the queue would be counting those.
 */
func replayEmails(t *testing.T, h *harness, topic string) []string {
	t.Helper()
	pending, err := h.store.PendingDeliveries(context.Background(), 100)
	if err != nil {
		t.Fatalf("pending deliveries: %v", err)
	}
	var out []string
	for _, p := range pending {
		if p.Subject == "The recording is ready: "+topic {
			out = append(out, p.Email+"|"+p.Body)
		}
	}
	return out
}

func replayFor(t *testing.T, h *harness, topic, email string) string {
	t.Helper()
	for _, row := range replayEmails(t, h, topic) {
		if strings.HasPrefix(row, email+"|") {
			return strings.TrimPrefix(row, email+"|")
		}
	}
	t.Fatalf("no replay mail for %s", email)
	return ""
}

func TestPublishingARecordingTellsTheRegistrants(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureReplayLinks)

	// whatsappReminders deliberately OFF for this webinar: the replay is not a reminder
	// and is not governed by that switch. See the note in PendingWhatsApp.
	const topic = "Scaling Postgres"
	wb := remindersWebinar(t, h, topic, false)
	optedIn := registerOptedIn(t, h, wb.ID)

	/* An email-only registrant, registered without going through the CRM helpers: the
	 * replay mail goes to everyone who was approved, including the people who are not
	 * WhatsApp contacts at all, and that is the majority of any real list. */
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Sipho", LastName: "Dlamini", Email: "sipho@example.com", Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register email-only: status %d body %s", res.StatusCode, raw)
	}

	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReplay, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"replay"},
	})

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start webinar: status %d body %s", res.StatusCode, raw)
	}
	rec := readyRecording(t, h, wb.ID)

	// Nothing is said while the recording is private, which is the whole reason the
	// trigger is the share switch and not the upload finishing.
	if mails := replayEmails(t, h, topic); len(mails) != 0 {
		t.Fatalf("%d replay mails queued before the recording was published", len(mails))
	}

	publishRecording(t, h, wb.ID, rec.ID, true)

	mails := replayEmails(t, h, topic)
	if len(mails) != 2 {
		t.Fatalf("%d replay mails, want one per approved registrant:\n%s", len(mails), strings.Join(mails, "\n---\n"))
	}

	/* The link is the public recording page — the same one the host copies out of the
	 * recordings tab, with no access token on it. A replay mail carrying a personal join
	 * link would be a forwardable credential, which is why notify.Invite keeps ReplayURL
	 * and JoinURL as two separate fields.
	 */
	want := "/w/" + wb.ID + "/recording/" + rec.ID
	body := replayFor(t, h, topic, "sipho@example.com")
	if !strings.Contains(body, want) {
		t.Errorf("mail does not carry the recording link %q:\n%s", want, body)
	}
	if strings.Contains(body, "token=") || strings.Contains(body, "/join") {
		t.Errorf("replay mail carries a join link:\n%s", body)
	}
	if !strings.Contains(body, "Sipho") {
		t.Errorf("mail does not greet the registrant by name:\n%s", body)
	}

	// One WhatsApp message, to the one person who gave a number and ticked the box.
	pending, err := h.store.PendingWhatsApp(context.Background(), 100)
	if err != nil {
		t.Fatalf("pending whatsapp: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("%d WhatsApp replay messages queued, want one: %+v", len(pending), pending)
	}
	if pending[0].ContactID != optedIn.ID {
		t.Errorf("queued for contact %s, want the opted-in one", pending[0].ContactID)
	}
	if pending[0].TemplateName != testTemplateUtility {
		t.Errorf("template = %q, want the one configured for the replay", pending[0].TemplateName)
	}
	if len(pending[0].Params) != 1 || !strings.Contains(pending[0].Params[0], want) {
		t.Errorf("params = %v, want the recording link resolved into {{1}}", pending[0].Params)
	}

	/* Flipping the switch back and forth does not send anybody a second copy.
	 *
	 * Enforced by the dedupe indexes rather than by a check in Go, and this is the case
	 * that matters most: a host who unpublishes a recording to fix its passcode and
	 * publishes it again has not asked to message four hundred people twice.
	 */
	publishRecording(t, h, wb.ID, rec.ID, false)
	publishRecording(t, h, wb.ID, rec.ID, true)
	if again := replayEmails(t, h, topic); len(again) != 2 {
		t.Errorf("%d replay mails after republishing, want the same two", len(again))
	}
	if again, _ := h.store.PendingWhatsApp(context.Background(), 100); len(again) != 1 {
		t.Errorf("%d WhatsApp replays after republishing, want the same one", len(again))
	}

	// And what actually reaches Meta carries the link, once.
	drainWhatsAppOutbox(t, h, wb.ID)
	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("%d sends reached Meta, want one", len(sends))
	}
	// Whole body, stringified: the link's place in a template send is inside a nested
	// parameters array, and what matters here is that it arrived at all.
	if sent := fmt.Sprint(lastSend(t, g)); !strings.Contains(sent, want) {
		t.Errorf("the send does not carry the recording link:\n%s", sent)
	}
}

/* The replay outlives the webinar, which nothing else in the outbox does.
 *
 * Every other queued message is a promise about something that has not happened yet, so
 * both pending queries drop notifications for an ended session — a reminder for a webinar
 * that is over is a bug, and sweeping it away is correct. The replay is the exact
 * opposite: it exists BECAUSE the session is over. Without the exemption in those two
 * queries this feature would write perfect rows that were never once delivered.
 */
func TestReplayStillGoesOutAfterTheWebinarHasEnded(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureReplayLinks)

	const topic = "A webinar that is over"
	wb := remindersWebinar(t, h, topic, false)
	registerOptedIn(t, h, wb.ID)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReplay, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"replay"},
	})

	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	rec := readyRecording(t, h, wb.ID)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}

	publishRecording(t, h, wb.ID, rec.ID, true)

	if mails := replayEmails(t, h, topic); len(mails) != 1 {
		t.Errorf("%d replay mails deliverable for an ended webinar, want one", len(mails))
	}
	pending, err := h.store.PendingWhatsApp(context.Background(), 100)
	if err != nil {
		t.Fatalf("pending whatsapp: %v", err)
	}
	if len(pending) != 1 {
		t.Errorf("%d WhatsApp replays deliverable for an ended webinar, want one: %+v",
			len(pending), pending)
	}
}

/* What the switch and the template each decide.
 *
 * Two separate refusals that look the same from the outside and are not: without the
 * account feature nothing is sent at all — the product behaves exactly as it did before
 * this existed, and a host can still publish a recording and send the link themselves.
 * Without a chosen template only the WhatsApp half is missing, because that is the half
 * Meta charges the host for and there is nothing to charge it against.
 */
func TestReplayNeedsTheSwitchAndAChosenTemplate(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	const off = "Nothing is switched on"
	wb := remindersWebinar(t, h, off, false)
	registerOptedIn(t, h, wb.ID)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReplay, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"replay"},
	})
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	rec := readyRecording(t, h, wb.ID)
	publishRecording(t, h, wb.ID, rec.ID, true)

	if mails := replayEmails(t, h, off); len(mails) != 0 {
		t.Errorf("%d replay mails with the feature off", len(mails))
	}
	if pending, _ := h.store.PendingWhatsApp(context.Background(), 100); len(pending) != 0 {
		t.Errorf("%d WhatsApp replays with the feature off: %+v", len(pending), pending)
	}
	// Publishing still worked, which is the point of the feature being about the
	// message and not about the recording.
	if !publishRecording(t, h, wb.ID, rec.ID, true).IsPublic {
		t.Error("the recording was not published")
	}

	// Now with the switch on and no replay template chosen: email only.
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureReplayLinks)
	setReminders(t, h) // clears every template, including the replay one
	const only = "Email only"
	wb2 := remindersWebinar(t, h, only, false)
	registerOptedIn(t, h, wb2.ID)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb2.ID+"/start", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start: status %d body %s", res.StatusCode, raw)
	}
	rec2 := readyRecording(t, h, wb2.ID)
	publishRecording(t, h, wb2.ID, rec2.ID, true)

	if mails := replayEmails(t, h, only); len(mails) != 1 {
		t.Errorf("%d replay mails without a WhatsApp template, want one", len(mails))
	}
	if pending, _ := h.store.PendingWhatsApp(context.Background(), 100); len(pending) != 0 {
		t.Errorf("%d WhatsApp replays with no template chosen: %+v", len(pending), pending)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d sends reached Meta", len(sends))
	}
}
