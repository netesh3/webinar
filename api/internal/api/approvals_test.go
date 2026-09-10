package api_test

/* The host approval workflow, end to end.
 *
 * Three things are worth proving here and the third is the one that would actually hurt:
 *
 *   1. A manual-approval webinar produces a PENDING registration whose access token does not
 *      work, and an approval turns it into one that does.
 *   2. The batch endpoint changes exactly the rows asked for, and reports honestly when it
 *      changed fewer.
 *   3. The ids in the request body are scoped to the webinar in the URL. requireOwnership
 *      proves the caller owns the webinar; it says NOTHING about ids they invented. Without
 *      the store's slug predicate a host could approve strangers into somebody else's session
 *      with a request they are fully authorised to make.
 */

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* soon is INSIDE the 15-minute door, so these tests measure the approval gate and nothing else.
 *
 * The first version of this put the start 90 minutes out, reasoning that a distant webinar
 * keeps the join window out of the way. It does the opposite: the door is shut until 15 minutes
 * before, so an approved registrant was correctly refused with `too_early` and the test read as
 * "approval does not work". Two gates guard the room and a test of one has to leave the other
 * open. Five minutes matches the convention already used elsewhere in this package.
 */
func soon() string {
	return time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
}

// manualWebinar creates a webinar that requires approval, owned by the logged-in caller.
func manualWebinar(t *testing.T, h *harness, topic string) types.Webinar {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic":                topic,
		"startsAt":             soon(),
		"durationMin":          45,
		"status":               "scheduled",
		"registrationRequired": true,
		"approval":             "manual",
		"attendeeLimit":        100,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create manual webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if wb.Approval != types.ApprovalManual {
		t.Fatalf("approval = %q, want manual — the rest of this test is meaningless", wb.Approval)
	}
	return wb
}

// registerGuest registers somebody with no account, the way the public form does.
func registerGuest(t *testing.T, h *harness, slug, email string) types.Registration {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/register", types.RegisterRequest{
		FirstName: "Guest", LastName: strings.SplitN(email, "@", 2)[0],
		Email: email, Phone: "+919876543210", Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: status %d body %s", email, res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	return reg
}

/* TestManualApprovalGatesTheAccessToken is the whole point of the pending state.
 *
 * A registration in the manual flow gets a join key immediately — the schema has join_key NOT
 * NULL — so the token existing is not the same as the token working. This asserts the gate is
 * on the STATE, which is the only thing standing between "requires approval" and "does not".
 */
func TestManualApprovalGatesTheAccessToken(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := manualWebinar(t, h, "Approval gate")

	reg := registerGuest(t, h, wb.ID, "pending-guest@test.dev")
	if reg.State != types.RegPending {
		t.Fatalf("state = %q, want pending", reg.State)
	}
	if reg.JoinKey == "" {
		t.Fatal("no join key issued; the approval email would have nothing to link to")
	}

	// The token exists and must not work yet.
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		map[string]string{"joinKey": reg.JoinKey})
	if res.StatusCode == http.StatusOK {
		t.Fatalf("a PENDING registration was let into the room: %s", raw)
	}

	// Approve, then the same token works.
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{IDs: []string{idOf(t, h, wb.ID, "pending-guest@test.dev")}, State: types.RegApproved})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approve: status %d body %s", res.StatusCode, raw)
	}
	var out types.ApprovalsResponse
	h.decode(raw, &out)
	if out.Changed != 1 {
		t.Errorf("changed = %d, want 1", out.Changed)
	}

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		map[string]string{"joinKey": reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("an APPROVED registration was refused: status %d body %s", res.StatusCode, raw)
	}
}

// idOf finds a registrant's row id by email, the way the host's panel does.
func idOf(t *testing.T, h *harness, slug, email string) string {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("registrants: status %d body %s", res.StatusCode, raw)
	}
	var rows []types.RegistrantRow
	h.decode(raw, &rows)
	for _, r := range rows {
		if strings.EqualFold(r.Email, email) {
			return r.ID
		}
	}
	t.Fatalf("no registrant with email %q", email)
	return ""
}

/* TestBatchApprovalIsSelectiveAndHonest.
 *
 * The selective part is the reason this endpoint exists: "approve all" already existed, and a
 * host reviewing strangers needs to approve some and decline others. The honest part is that
 * the response reports what CHANGED, not what was asked for — re-approving somebody already
 * approved must not count, because the count is what decides whether they get a second
 * invitation email.
 */
func TestBatchApprovalIsSelectiveAndHonest(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := manualWebinar(t, h, "Selective batch")

	for _, e := range []string{"a@test.dev", "b@test.dev", "c@test.dev"} {
		registerGuest(t, h, wb.ID, e)
		h.login("neeraj@acme.dev") // registering as a guest replaces the session cookie
	}

	// The queue endpoint returns only rows needing a decision.
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/approvals", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("approvals queue: status %d body %s", res.StatusCode, raw)
	}
	var queue []types.RegistrantRow
	h.decode(raw, &queue)
	if len(queue) != 3 {
		t.Fatalf("queue has %d rows, want 3", len(queue))
	}
	for _, r := range queue {
		if r.State != types.RegPending {
			t.Errorf("queue contains a %s row; it must only carry pending", r.State)
		}
	}

	a, b := idOf(t, h, wb.ID, "a@test.dev"), idOf(t, h, wb.ID, "b@test.dev")

	// Approve two of the three.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{IDs: []string{a, b}, State: types.RegApproved})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("batch approve: status %d body %s", res.StatusCode, raw)
	}
	var out types.ApprovalsResponse
	h.decode(raw, &out)
	if out.Changed != 2 {
		t.Errorf("changed = %d, want 2", out.Changed)
	}
	if out.Notified != 2 {
		t.Errorf("notified = %d, want 2 — an approved registrant who is never told is not in", out.Notified)
	}

	// The third is untouched.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/approvals", nil)
	h.decode(raw, &queue)
	if len(queue) != 1 || !strings.EqualFold(queue[0].Email, "c@test.dev") {
		t.Errorf("after approving two, the queue should hold only c@test.dev; got %+v", queue)
	}

	// Re-approving the same two changes nothing and notifies nobody.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{IDs: []string{a, b}, State: types.RegApproved})
	h.decode(raw, &out)
	if out.Changed != 0 || out.Notified != 0 {
		t.Errorf("re-approving changed=%d notified=%d, want 0/0 — this would send a second invitation",
			out.Changed, out.Notified)
	}

	// An empty selection is accepted and does nothing, rather than erroring.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{IDs: nil, State: types.RegApproved})
	if res.StatusCode != http.StatusOK {
		t.Errorf("empty selection: status %d body %s, want 200", res.StatusCode, raw)
	}

	// A state this server does not have is refused.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		map[string]any{"ids": []string{a}, "state": "banished"})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("bogus state: status %d body %s, want 422", res.StatusCode, raw)
	}
}

/* TestBatchApprovalCannotReachAnotherWebinarsRegistrations is the one that matters.
 *
 * The caller is a legitimate host acting on their OWN webinar, so requireOwnership passes and
 * cannot help. The only thing stopping them approving a stranger into somebody else's session
 * is the slug predicate inside the UPDATE.
 */
func TestBatchApprovalCannotReachAnotherWebinarsRegistrations(t *testing.T) {
	h := newHarness(t)

	// Lucía's webinar, with somebody pending on it.
	h.login("lucia@cabify.com")
	victimWebinar := manualWebinar(t, h, "Lucia's session")
	registerGuest(t, h, victimWebinar.ID, "victim@test.dev")
	h.login("lucia@cabify.com")
	victimID := idOf(t, h, victimWebinar.ID, "victim@test.dev")

	// Neeraj's own webinar, which he is fully entitled to administer.
	h.login("neeraj@acme.dev")
	mine := manualWebinar(t, h, "Neeraj's session")

	// His request, his webinar in the URL, her registration id in the body.
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+mine.ID+"/approvals",
		types.ApprovalsRequest{IDs: []string{victimID}, State: types.RegApproved})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s — expected a successful no-op", res.StatusCode, raw)
	}
	var out types.ApprovalsResponse
	h.decode(raw, &out)
	if out.Changed != 0 {
		t.Errorf("changed = %d: a host approved a registration on ANOTHER host's webinar", out.Changed)
	}

	// And she still has somebody waiting.
	h.login("lucia@cabify.com")
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+victimWebinar.ID+"/approvals", nil)
	var queue []types.RegistrantRow
	h.decode(raw, &queue)
	if len(queue) != 1 {
		t.Errorf("her queue has %d rows, want 1 — her pending registration was altered", len(queue))
	}
}

/* TestHostIsAlertedWhenSomebodyIsWaiting.
 *
 * The alert is addressed to the host's user id rather than an email address, so it works on a
 * deployment with no mail server — which is this one. That is the reason the in-app path is
 * the primary one and email is the optional extra, not the other way round.
 */
func TestHostIsAlertedWhenSomebodyIsWaiting(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	wb := manualWebinar(t, h, "Alert me")

	// No alerts yet.
	res, raw := h.do(http.MethodGet, "/api/host/alerts", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("alerts: status %d body %s", res.StatusCode, raw)
	}
	var before types.AlertsResponse
	h.decode(raw, &before)

	registerGuest(t, h, wb.ID, "waiting@test.dev")
	h.login("neeraj@acme.dev")

	res, raw = h.do(http.MethodGet, "/api/host/alerts", nil)
	var after types.AlertsResponse
	h.decode(raw, &after)
	if after.Unread != before.Unread+1 {
		t.Fatalf("unread went %d -> %d, want +1", before.Unread, after.Unread)
	}
	if len(after.Alerts) == 0 {
		t.Fatal("no alert rows returned")
	}
	top := after.Alerts[0]
	if top.Kind != types.NotifyApprovalRequested {
		t.Errorf("kind = %q, want approval_requested", top.Kind)
	}
	if top.WebinarID != wb.ID {
		t.Errorf("alert points at %q, want %q", top.WebinarID, wb.ID)
	}
	if !strings.Contains(top.Body, "approval") {
		t.Errorf("alert body does not say what is needed: %q", top.Body)
	}
	// The host's own join link must never be in an alert about somebody else.
	if strings.Contains(top.Body, "/room?k=") {
		t.Error("the host's alert contains a registrant's access token")
	}

	// Marking read clears the badge.
	res, raw = h.do(http.MethodPost, "/api/host/alerts/read", map[string][]string{"ids": nil})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("mark read: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/alerts", nil)
	var cleared types.AlertsResponse
	h.decode(raw, &cleared)
	if cleared.Unread != 0 {
		t.Errorf("unread = %d after marking all read, want 0", cleared.Unread)
	}
}

/* TestOneHostCannotSeeAnotherHostsAlerts.
 *
 * The alerts endpoint takes no id, so the scope is entirely the SQL predicate on user_id.
 * That makes it exactly the kind of thing that is correct until somebody adds a filter
 * parameter, so it gets a test.
 */
func TestOneHostCannotSeeAnotherHostsAlerts(t *testing.T) {
	h := newHarness(t)

	h.login("lucia@cabify.com")
	wb := manualWebinar(t, h, "Lucia's private queue")
	registerGuest(t, h, wb.ID, "hers@test.dev")

	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/host/alerts", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("alerts: status %d body %s", res.StatusCode, raw)
	}
	if strings.Contains(string(raw), "Lucia's private queue") {
		t.Errorf("one host can read another host's alerts\n  body: %s", raw)
	}
}
