package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Drips: a sequence nobody is watching.
 *
 * What is new here, and what every test below is really about, is that the host is
 * absent when a drip sends. A broadcast is wrong in front of somebody; a drip is wrong
 * two days later, to people who registered after it was written. So the claims are:
 *
 *   - a step only ever goes to somebody who could be messaged at the moment it goes,
 *     not at the moment they were enrolled. STOP on Tuesday closes the sequence.
 *   - nobody enters twice. A second registration must not restart a sequence somebody
 *     has already had, because the trigger fires again and the person does not know it.
 *   - the builder refuses everything the send would refuse. A sequence whose third step
 *     names an unapproved template fails for one person, days later, silently.
 *
 * Time is not faked: the steps here wait zero minutes, so one sweep queues one step and
 * the next queues the one after it. A step with a real delay is used once, to assert
 * that it is NOT sent.
 */

// dripStep is the two-line version of a step, since most of these only vary the wait.
func dripStep(delay int, params ...types.CRMParam) types.CRMDripStep {
	if params == nil {
		params = []types.CRMParam{}
	}
	tmpl, lang := testTemplateUtility, "en_US"
	if len(params) == 0 {
		// The one approved template that takes no values, for a step that needs none.
		tmpl = testTemplateMarketing
	}
	return types.CRMDripStep{DelayMinutes: delay, Template: tmpl, Language: lang, Params: params}
}

func createDrip(t *testing.T, h *harness, body types.CRMDripRequest) types.CRMDripResponse {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/crm/drips", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create drip: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMDripResponse
	h.decode(raw, &out)
	return out
}

func readDrip(t *testing.T, h *harness, id string) types.CRMDripResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/drips/"+id, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("read drip: status %d body %s", res.StatusCode, raw)
	}
	var out types.CRMDripResponse
	h.decode(raw, &out)
	return out
}

/* runDrips is one tick of the sweeper: queue whatever is due, then send it.
 *
 * Both halves, because that is what the ticker does and because either one alone
 * proves nothing — a queued step that is never flushed has not reached anybody, and a
 * flush with nothing queued is not a sequence advancing. The drip half has no HTTP
 * surface at all, which is why the harness keeps the server; see AdvanceDrips.
 */
func runDrips(t *testing.T, h *harness, slug string) {
	t.Helper()
	h.server.AdvanceDrips(context.Background())
	drainWhatsAppOutbox(t, h, slug)
}

// onlyEnrollment is the single person a test expects to be on a sequence.
func onlyEnrollment(t *testing.T, d types.CRMDripResponse) types.CRMDripEnrollment {
	t.Helper()
	if len(d.Enrollments) != 1 {
		t.Fatalf("%d enrollments, want exactly one: %+v", len(d.Enrollments), d.Enrollments)
	}
	return d.Enrollments[0]
}

/* The builder refuses everything the send would refuse.
 *
 * The most valuable test in this file, because of when a drip fails: a sequence saved
 * with a template Meta has not approved works for two days and then stops, for one
 * person at a time, with nobody watching. Every one of these is a refusal while the
 * host is still looking at the form — and none of them reach Meta.
 */
func TestCRMDripBuilderRefusesWhatItCannotSend(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	/* Before the host has connected WhatsApp there is nothing to build a sequence out
	 * of: the templates come from their own WABA. Refused rather than saved as a draft,
	 * because a sequence naming templates from nowhere would be checked against nothing. */
	res, raw := h.do(http.MethodPost, "/api/host/crm/drips", types.CRMDripRequest{
		Name: "Welcome", Trigger: types.DripRegistered, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	})
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "whatsapp_not_connected" {
		t.Fatalf("unconnected host: status %d code %q body %s", res.StatusCode, errorCode(t, raw), raw)
	}

	connectWhatsApp(t, h)

	for _, tc := range []struct {
		name, code string
		body       types.CRMDripRequest
	}{
		{"no name", "crm_no_name", types.CRMDripRequest{
			Trigger: types.DripRegistered, Steps: []types.CRMDripStep{dripStep(0)}}},
		{"a trigger that does not exist", "crm_bad_trigger", types.CRMDripRequest{
			Name: "S", Trigger: "when_they_smile", Steps: []types.CRMDripStep{dripStep(0)}}},
		{"no steps at all", "crm_drip_no_steps", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered}},
		{"a template Meta has not approved", "crm_template_unusable", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, Steps: []types.CRMDripStep{
				{Template: testTemplatePending, Language: "en_US"}}}},
		{"a template that is not theirs", "crm_no_template", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, Steps: []types.CRMDripStep{
				{Template: "somebody_elses", Language: "en_US"}}}},
		{"too few values for the template", "crm_template_params", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, Steps: []types.CRMDripStep{
				{Template: testTemplateUtility, Language: "en_US"}}}},
		{"a value left blank", "crm_bad_param", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, Steps: []types.CRMDripStep{
				dripStep(0, types.CRMParam{Text: "   "})}}},
		{"a merge field this server cannot fill", "crm_bad_merge_field", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, Steps: []types.CRMDripStep{
				dripStep(0, types.CRMParam{Field: "favourite_colour"})}}},
		/* The webinar merge fields on a sequence with no webinar anywhere in sight. A
		 * manual drip has no registration to infer one from, so "starts —" is what the
		 * message would say to everybody the host adds. */
		{"the webinar's topic on a manual sequence", "crm_no_webinar", types.CRMDripRequest{
			Name: "S", Trigger: types.DripManual, Steps: []types.CRMDripStep{
				dripStep(0, types.CRMParam{Field: "topic"})}}},
		{"a wait measured in months", "crm_drip_bad_delay", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, Steps: []types.CRMDripStep{
				dripStep(200 * 24 * 60)}}},
		{"somebody else's webinar", "crm_no_webinar", types.CRMDripRequest{
			Name: "S", Trigger: types.DripRegistered, WebinarID: "not-a-webinar-of-mine",
			Steps: []types.CRMDripStep{dripStep(0)}}},
	} {
		res, raw := h.do(http.MethodPost, "/api/host/crm/drips", tc.body)
		if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != tc.code {
			t.Errorf("%s: status %d code %q, want 422 %s\n  body: %s",
				tc.name, res.StatusCode, errorCode(t, raw), tc.code, raw)
		}
	}

	/* The same webinar field is allowed the moment there IS a webinar to resolve it
	 * against — including on a sequence that names no webinar itself, because its
	 * trigger gives every person on it one. That distinction is the reason this is not
	 * simply "topic needs a slug". */
	perPerson := createDrip(t, h, types.CRMDripRequest{
		Name: "Follow up", Trigger: types.DripRegistered, Active: true,
		Steps: []types.CRMDripStep{dripStep(0, types.CRMParam{Field: "topic"})},
	})
	if perPerson.Drip.WebinarID != "" {
		t.Errorf("webinarId = %q, want a sequence scoped to no webinar in particular",
			perPerson.Drip.WebinarID)
	}
	scoped := createDrip(t, h, types.CRMDripRequest{
		Name: "One webinar only", Trigger: types.DripEnded, WebinarID: wb.ID, Active: true,
		Steps: []types.CRMDripStep{dripStep(0, types.CRMParam{Field: "topic"})},
	})
	if scoped.Drip.WebinarID != wb.ID || scoped.Drip.WebinarTopic != "Scaling Postgres" {
		t.Errorf("drip = %+v, want it kept against the webinar it is about", scoped.Drip)
	}
	// A webinar posted with the manual trigger is dropped rather than refused: "add
	// people myself" is not about one webinar, and a host who changed their mind from
	// a webinar trigger has not made a mistake worth a red message.
	byHand := createDrip(t, h, types.CRMDripRequest{
		Name: "By hand", Trigger: types.DripManual, WebinarID: wb.ID, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	})
	if byHand.Drip.WebinarID != "" {
		t.Errorf("webinarId = %q on a manual sequence, want it dropped", byHand.Drip.WebinarID)
	}

	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d messages reached Meta while building sequences: %v\n"+
			"  saving a drip must send nothing at all", len(sends), sends)
	}
}

/* One registrant, one sequence, start to finish.
 *
 * The whole of Phase 3 in one test: the trigger enrolls, the sweep queues, the outbox
 * sends, and the values are each person's own. The two steps wait zero minutes, so the
 * second sweep is what a second day would be.
 */
func TestCRMDripRunsASequenceForARegistrant(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	created := createDrip(t, h, types.CRMDripRequest{
		Name: "After registering", Trigger: types.DripRegistered, Active: true,
		Steps: []types.CRMDripStep{
			dripStep(0, types.CRMParam{Field: "name"}),
			dripStep(0),
		},
	})
	drip := created.Drip
	if len(drip.Steps) != 2 || drip.Steps[0].Template != testTemplateUtility ||
		drip.Steps[1].Template != testTemplateMarketing {
		t.Fatalf("steps = %+v", drip.Steps)
	}
	if len(created.Enrollments) != 0 {
		t.Fatalf("creating a sequence enrolled %d people", len(created.Enrollments))
	}

	// Nobody is on it until somebody registers, which is the difference from a
	// broadcast: the audience does not exist yet when the sequence is written.
	thandi := registerOptedIn(t, h, wb.ID)
	entered := onlyEnrollment(t, readDrip(t, h, drip.ID))
	if entered.ContactID != thandi.ID || entered.State != "active" || entered.Step != 0 {
		t.Fatalf("enrollment = %+v, want Thandi waiting for her first message", entered)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Fatalf("%d messages sent by the registration itself: %v", len(sends), sends)
	}

	// First tick: the first step is queued and sent, and she moves on.
	runDrips(t, h, wb.ID)
	sends := g.sent()
	if len(sends) != 1 {
		t.Fatalf("%d sends after one sweep, want the first step only: %v", len(sends), sends)
	}
	if sends[0]["to"] != crmPhoneDigits {
		t.Errorf("sent to %v, want the registrant's number", sends[0]["to"])
	}
	after := readDrip(t, h, drip.ID)
	if got := onlyEnrollment(t, after); got.Step != 1 || got.State != "active" {
		t.Fatalf("enrollment = %+v after one step, want step 1 and still going", got)
	}
	if after.Drip.Stats.Active != 1 || after.Drip.Stats.Sent != 1 || after.Drip.Stats.Done != 0 {
		t.Errorf("stats = %+v after one step", after.Drip.Stats)
	}
	/* Resolved for her, and visible where it matters: her own thread holds the words
	 * she actually read. One rendering for everybody would have been the easy bug. */
	if got := threadFor(t, h, thandi.ID); len(got.Messages) != 1 ||
		got.Messages[0].Body != "Hi Thandi Mokoena, your webinar starts in an hour." {
		t.Errorf("thread after the first step = %+v", got.Messages)
	}

	// Second tick: the last step goes, and the sequence is finished rather than active.
	runDrips(t, h, wb.ID)
	done := readDrip(t, h, drip.ID)
	if got := onlyEnrollment(t, done); got.State != "done" || got.Step != 2 {
		t.Fatalf("enrollment = %+v after the last step, want done", got)
	}
	if done.Drip.Stats.Done != 1 || done.Drip.Stats.Active != 0 || done.Drip.Stats.Sent != 2 {
		t.Errorf("stats = %+v at the end", done.Drip.Stats)
	}
	if got := threadFor(t, h, thandi.ID); len(got.Messages) != 2 ||
		got.Messages[1].Body != "New course, live next week." {
		t.Errorf("thread at the end = %+v", got.Messages)
	}

	// A third tick has nothing to do. Asserted because "done" that keeps sending is
	// the failure mode with the worst consequences and no error message.
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 2 {
		t.Fatalf("%d sends after a finished sequence was swept again: %v", len(sends), sends)
	}

	/* And registering again does not start her over. The trigger fires on every
	 * registration, so without one-per-person a lead who signs up for two webinars
	 * gets the sequence twice — and only the host is billed for noticing. */
	second := remindersWebinar(t, h, "Another session", true)
	registerOptedIn(t, h, second.ID)
	if got := onlyEnrollment(t, readDrip(t, h, drip.ID)); got.State != "done" {
		t.Errorf("enrollment = %+v after a second registration, want it left finished", got)
	}
	runDrips(t, h, second.ID)
	if sends := g.sent(); len(sends) != 2 {
		t.Fatalf("%d sends after re-registering, want no restart: %v", len(sends), sends)
	}
}

/* STOP ends the sequence, not just the message that was due.
 *
 * The case the whole design is arranged around. A sequence runs for weeks, and the
 * person on it can withdraw halfway through; the queued step has to be retired, the
 * enrollment has to say why, and — the part that is easy to miss — the remaining steps
 * must never be queued at all, because a row the outbox refuses to send sits pending
 * for ever and reads, to the host, as somebody still part-way through.
 */
func TestCRMDripStopsWhenSomebodyOptsOut(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "Three messages", Trigger: types.DripRegistered, Active: true,
		Steps: []types.CRMDripStep{
			dripStep(0, types.CRMParam{Field: "name"}),
			dripStep(0),
			dripStep(0),
		},
	}).Drip

	thandi := registerOptedIn(t, h, wb.ID)
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 1 {
		t.Fatalf("%d sends before the reply, want the first step: %v", len(sends), sends)
	}

	// The reply Meta forwards for a bare STOP. Through the webhook rather than the
	// host's own opt-out button, because this is the version the person themselves does.
	postWebhook(t, h, inboundPayload("wamid.STOP1", crmPhoneDigits, "Thandi", "STOP"))

	stopped := onlyEnrollment(t, readDrip(t, h, drip.ID))
	if stopped.State != "exited" || stopped.ExitReason != "opted out" {
		t.Fatalf("enrollment = %+v after STOP, want it exited with the reason", stopped)
	}

	// And two more ticks send nothing, however many steps were left.
	runDrips(t, h, wb.ID)
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 1 {
		t.Fatalf("%d sends after STOP: %v\n  a sequence must stop when the person says stop",
			len(sends), sends)
	}
	final := readDrip(t, h, drip.ID)
	if final.Drip.Stats.Exited != 1 || final.Drip.Stats.Queued != 0 || final.Drip.Stats.Sent != 1 {
		t.Errorf("stats = %+v after STOP, want nothing left queued", final.Drip.Stats)
	}
	if got := threadFor(t, h, thandi.ID); len(got.Messages) != 2 {
		// The first step and her own STOP. Her reply is part of the conversation.
		t.Errorf("thread = %+v", got.Messages)
	}
}

/* Pausing holds a sequence without losing anybody's place.
 *
 * The reason pause exists at all rather than only delete: a host who notices a mistake
 * in step three wants everybody to stop where they are, not to be taken off and
 * re-enrolled from the beginning when it is fixed.
 */
func TestCRMDripPauseHoldsQueuedStepsAndResumes(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	steps := []types.CRMDripStep{dripStep(0, types.CRMParam{Field: "name"}), dripStep(0)}
	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "Pausable", Trigger: types.DripRegistered, Active: true, Steps: steps,
	}).Drip
	registerOptedIn(t, h, wb.ID)

	// Paused after somebody is on it and before the first sweep: the step is due and
	// the host has said stop. Nothing goes out, and nothing is thrown away either.
	res, raw := h.do(http.MethodPut, "/api/host/crm/drips/"+drip.ID, types.CRMDripRequest{
		Name: "Pausable", Trigger: types.DripRegistered, Active: false, Steps: steps,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("pause: status %d body %s", res.StatusCode, raw)
	}
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 0 {
		t.Fatalf("%d sends from a paused sequence: %v", len(sends), sends)
	}
	paused := onlyEnrollment(t, readDrip(t, h, drip.ID))
	if paused.State != "active" || paused.Step != 0 {
		t.Errorf("enrollment = %+v while paused, want everybody left where they are", paused)
	}

	// Switched back on, it carries on from where it stopped.
	res, raw = h.do(http.MethodPut, "/api/host/crm/drips/"+drip.ID, types.CRMDripRequest{
		Name: "Pausable", Trigger: types.DripRegistered, Active: true, Steps: steps,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("resume: status %d body %s", res.StatusCode, raw)
	}
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 1 {
		t.Fatalf("%d sends after resuming, want the held step: %v", len(sends), sends)
	}
	if got := onlyEnrollment(t, readDrip(t, h, drip.ID)); got.Step != 1 {
		t.Errorf("enrollment = %+v after resuming", got)
	}
}

/* Adding somebody by hand, and taking them off again.
 *
 * The manual trigger's whole implementation, and the plan's "manual removal". The
 * removal is the interesting half: the enrollment is kept and marked, because deleting
 * it would let the next trigger put the same person straight back on.
 */
func TestCRMDripManualEnrollmentAndRemoval(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	thandi := registerOptedIn(t, h, wb.ID)
	noConsent := registerWithPhone(t, h, wb.ID, "Sam", "sam@example.com", broadcastPhone2, false)

	drip := createDrip(t, h, types.CRMDripRequest{
		Name: "By hand", Trigger: types.DripManual, Active: true,
		Steps: []types.CRMDripStep{dripStep(0, types.CRMParam{Field: "name"}), dripStep(0)},
	}).Drip

	enroll := func(contactID string) (*http.Response, []byte) {
		return h.do(http.MethodPost, "/api/host/crm/drips/"+drip.ID+"/enrollments",
			types.CRMDripEnrollRequest{ContactID: contactID})
	}

	res, raw := enroll(thandi.ID)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("enroll: status %d body %s", res.StatusCode, raw)
	}
	var added types.CRMDripResponse
	h.decode(raw, &added)
	person := onlyEnrollment(t, added)
	if person.ContactID != thandi.ID || person.ContactName != "Thandi Mokoena" {
		t.Errorf("enrollment = %+v, want the contact named", person)
	}

	// Twice is refused rather than silently ignored: a host pressed a button and is
	// owed the reason. So is somebody who never agreed to be messaged.
	for _, tc := range []struct{ name, contact string }{
		{"the same person again", thandi.ID},
		{"somebody who never opted in", noConsent.ID},
	} {
		res, raw := enroll(tc.contact)
		if res.StatusCode != http.StatusUnprocessableEntity ||
			errorCode(t, raw) != "crm_drip_not_enrolled" {
			t.Errorf("%s: status %d code %q, want 422 crm_drip_not_enrolled\n  body: %s",
				tc.name, res.StatusCode, errorCode(t, raw), raw)
		}
	}

	// The first step goes out like any other.
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 1 {
		t.Fatalf("%d sends after adding somebody by hand: %v", len(sends), sends)
	}

	// Removed: marked and explained, with the step that was waiting retired.
	res, raw = h.do(http.MethodDelete,
		"/api/host/crm/drips/"+drip.ID+"/enrollments/"+person.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("remove: status %d body %s", res.StatusCode, raw)
	}
	var removed types.CRMDripResponse
	h.decode(raw, &removed)
	if got := onlyEnrollment(t, removed); got.State != "exited" ||
		got.ExitReason != "removed by the host" {
		t.Fatalf("enrollment = %+v after removal", got)
	}
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 1 {
		t.Fatalf("%d sends after removal, want the remaining step dropped: %v", len(sends), sends)
	}

	// Removing them twice is a 404 on the enrollment, not a second success.
	if res, _ := h.do(http.MethodDelete,
		"/api/host/crm/drips/"+drip.ID+"/enrollments/"+person.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("second removal: status %d, want 404", res.StatusCode)
	}

	/* And another host cannot see it, add to it, or take anybody off it. The sequence
	 * holds names and phone numbers of somebody else's leads, so every one of these
	 * reads as a sequence that does not exist. */
	h.logout()
	h.login("lucia@cabify.com")
	// Connected, so that every refusal below is about whose sequence it is rather than
	// about her own setup — which the builder checks first, and should.
	connectWhatsApp(t, h)
	for _, tc := range []struct {
		name, method, path string
		body               any
	}{
		{"read", http.MethodGet, "/api/host/crm/drips/" + drip.ID, nil},
		{"edit", http.MethodPut, "/api/host/crm/drips/" + drip.ID, types.CRMDripRequest{
			Name: "Mine now", Trigger: types.DripManual, Active: true,
			Steps: []types.CRMDripStep{dripStep(0)}}},
		{"enroll into", http.MethodPost, "/api/host/crm/drips/" + drip.ID + "/enrollments",
			types.CRMDripEnrollRequest{ContactID: thandi.ID}},
		{"remove from", http.MethodDelete,
			"/api/host/crm/drips/" + drip.ID + "/enrollments/" + person.ID, nil},
		{"delete", http.MethodDelete, "/api/host/crm/drips/" + drip.ID, nil},
	} {
		res, raw := h.do(tc.method, tc.path, tc.body)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("another host tried to %s the sequence: status %d body %s",
				tc.name, res.StatusCode, raw)
		}
	}
	var mine types.CRMDripsResponse
	_, raw = h.do(http.MethodGet, "/api/host/crm/drips", nil)
	h.decode(raw, &mine)
	if len(mine.Drips) != 0 {
		t.Errorf("another host's list = %+v", mine.Drips)
	}
}

/* The end of a webinar sorts its registrants into the sequences that want them.
 *
 * Three triggers on one event, and the split is the point: "thanks for coming" and
 * "sorry you missed it" are different messages, and sending either to the wrong half is
 * the kind of mistake a host hears about. Attendance is matched through the
 * registration, which is what joining with a personal link records.
 */
func TestCRMDripWebinarEndSortsAttendedFromNoShow(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)
	// A second, still-scheduled webinar, only so the outbox can be flushed after the
	// first one is over. No sequence here is triggered by registering.
	open := remindersWebinar(t, h, "Still to come", true)

	came := registerOptedIn(t, h, wb.ID)
	missed := registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", broadcastPhone3, true)

	attended := createDrip(t, h, types.CRMDripRequest{
		Name: "Thanks for coming", Trigger: types.DripAttended, Active: true,
		Steps: []types.CRMDripStep{dripStep(0, types.CRMParam{Field: "topic"})},
	}).Drip
	noShow := createDrip(t, h, types.CRMDripRequest{
		Name: "Sorry you missed it", Trigger: types.DripNoShow, Active: true,
		Steps: []types.CRMDripStep{dripStep(0, types.CRMParam{Field: "name"})},
	}).Drip
	everyone := createDrip(t, h, types.CRMDripRequest{
		Name: "The recording", Trigger: types.DripEnded, WebinarID: wb.ID, Active: true,
		Steps: []types.CRMDripStep{dripStep(0)},
	}).Drip

	/* One of them turned up. Written directly, because what the trigger reads is the
	 * attendance row — the same one the join path writes — and taking a fake SFU
	 * through a full join would be testing the join. */
	if err := h.store.TouchAttendance(context.Background(), wb.ID,
		"attendee-"+came.ID, idOf(t, h, wb.ID, "thandi@example.com"), "Thandi Mokoena"); err != nil {
		t.Fatalf("attendance: %v", err)
	}

	h.goLive(wb.ID)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end webinar: status %d body %s", res.StatusCode, raw)
	}

	for _, tc := range []struct {
		name, id, contact string
	}{
		{"attended", attended.ID, came.ID},
		{"no_show", noShow.ID, missed.ID},
	} {
		got := onlyEnrollment(t, readDrip(t, h, tc.id))
		if got.ContactID != tc.contact {
			t.Errorf("the %s sequence enrolled %s, want %s — the halves are swapped or the "+
				"attendance match is wrong", tc.name, got.ContactName, tc.contact)
		}
	}
	if got := readDrip(t, h, everyone.ID); len(got.Enrollments) != 2 {
		t.Errorf("the everyone sequence has %d people, want both registrants: %+v",
			len(got.Enrollments), got.Enrollments)
	}

	/* An ended webinar's reminders are skipped and its sequences are not: the whole
	 * point of a follow-up is that it goes out afterwards. The reminder sweep gates on
	 * the webinar's status, so a drip step carrying one would be silently held for ever.
	 *
	 * Swept through `open`, because the outbox is flushed by a registration and this
	 * webinar is over — nobody can register for it any more, which is the point. */
	runDrips(t, h, open.ID)
	sends := g.sent()
	if len(sends) != 4 {
		t.Fatalf("%d sends after the webinar ended, want four — one each from the attended "+
			"and no-show sequences and two from the everyone one: %v", len(sends), sends)
	}
	/* The topic merge field resolved from the enrollment's own webinar, on a sequence
	 * that names no webinar itself. Looked for rather than indexed: both of her messages
	 * were queued by the same sweep, so which one is first is not a claim worth making. */
	thread := threadFor(t, h, came.ID)
	if len(thread.Messages) != 2 {
		t.Fatalf("thread = %+v, want the attended message and the recording", thread.Messages)
	}
	filled := false
	for _, m := range thread.Messages {
		filled = filled || m.Body == "Hi Scaling Postgres, your webinar starts in an hour."
	}
	if !filled {
		t.Errorf("thread = %+v, want the webinar's topic filled in from her enrollment",
			thread.Messages)
	}

	// Ending it again enrolls nobody twice, which is what the meeting-limit sweeper
	// would do to a webinar whose host had already pressed End.
	if _, err := h.store.SetStatus(context.Background(), wb.ID, types.StatusLive); err != nil {
		t.Fatal(err)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end again: status %d body %s", res.StatusCode, raw)
	}
	runDrips(t, h, open.ID)
	if got := g.sent(); len(got) != 4 {
		t.Errorf("%d sends after the webinar ended twice, want the same four", len(got))
	}
}

/* A sequence deleted stops sending, and a sequence with a wait does not send early.
 *
 * Two small claims that share a fixture. The second one is the only place a real delay
 * is used: everything else waits zero minutes so that one sweep is one step.
 */
func TestCRMDripDelayHoldsAndDeleteStops(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := remindersWebinar(t, h, "Scaling Postgres", true)

	later := createDrip(t, h, types.CRMDripRequest{
		Name: "Tomorrow", Trigger: types.DripRegistered, Active: true,
		Steps: []types.CRMDripStep{dripStep(24*60, types.CRMParam{Field: "name"})},
	}).Drip
	registerOptedIn(t, h, wb.ID)

	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 0 {
		t.Fatalf("%d sends from a step due tomorrow: %v", len(sends), sends)
	}
	if got := onlyEnrollment(t, readDrip(t, h, later.ID)); got.State != "active" || got.NextDueAt == "" {
		t.Errorf("enrollment = %+v, want it waiting with a due time", got)
	}

	if res, raw := h.do(http.MethodDelete, "/api/host/crm/drips/"+later.ID, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}
	if res, _ := h.do(http.MethodGet, "/api/host/crm/drips/"+later.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("read after delete: status %d, want 404", res.StatusCode)
	}
	var list types.CRMDripsResponse
	_, raw := h.do(http.MethodGet, "/api/host/crm/drips", nil)
	h.decode(raw, &list)
	if len(list.Drips) != 0 {
		t.Errorf("list after delete = %+v", list.Drips)
	}
	if !list.WhatsAppConnected || len(list.Fields) == 0 || len(list.Triggers) == 0 {
		t.Errorf("list response = %+v, want the builder's own options with it", list)
	}
	runDrips(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("%d sends from a deleted sequence: %v", len(sends), sends)
	}
}
