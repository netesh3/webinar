package api_test

import (
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* "Who replied, and who can I still reach?" — in the webinar's tab and in the CRM.
 *
 * A host asks this question about one webinar, so both screens have to answer it about
 * the same people with the same words. The claims:
 *
 *  1. The registrant rows and the contacts list agree, person for person. They are two
 *     different queries over two different tables and the only thing holding them
 *     together is one shared SQL predicate, so this is the test that notices a copy.
 *  2. Each ?status= returns exactly the contacts its own chip counted. A chip that says
 *     3 and filters to 2 is worse than no chip.
 *  3. The counts are TWO partitions, not one. replied/no-reply covers everybody, and so
 *     does opted-in/no-opt-in/opted-out/no-number, and each sums to the total on its
 *     own. A contact can be both "no reply" and "no number", so anything that renders
 *     all six as one row is showing a total that cannot add up.
 *  4. A status nobody defined is refused, rather than answered with an unfiltered list
 *     that looks like a filtered one.
 */

// registrantRows reads the host's Attendees tab.
func registrantRows(t *testing.T, h *harness, slug string) []types.RegistrantRow {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("registrants: status %d body %s", res.StatusCode, raw)
	}
	var rows []types.RegistrantRow
	h.decode(raw, &rows)
	return rows
}

func registrantFor(t *testing.T, rows []types.RegistrantRow, email string) types.RegistrantRow {
	t.Helper()
	for _, r := range rows {
		if r.Email == email {
			return r
		}
	}
	t.Fatalf("no registrant %s in %d rows", email, len(rows))
	return types.RegistrantRow{}
}

func contactFor(t *testing.T, contacts []types.CRMContact, email string) types.CRMContact {
	t.Helper()
	for _, c := range contacts {
		if c.Email == email {
			return c
		}
	}
	t.Fatalf("no contact %s in %d contacts", email, len(contacts))
	return types.CRMContact{}
}

/* fourStates puts one webinar's registrants into every WhatsApp state there is, and
 * returns the webinar. One person per state, because the states are what the tests below
 * are about and a second example of each would only make a failure harder to read.
 */
func fourStates(t *testing.T, h *harness, host string) types.Webinar {
	t.Helper()
	wb := autoWebinar(t, h, "Who replied")

	// Opted in, and has written back.
	registerWithPhone(t, h, wb.ID, "Ayanda", "ayanda@example.com", crmContactPhone, true)
	h.login(host)
	postWebhook(t, h, inboundPayload("wamid.replied-1", crmPhoneDigits, "Ayanda", "Is it recorded?"))

	// A number, but never ticked the box.
	registerWithPhone(t, h, wb.ID, "Bheki", "bheki@example.com", broadcastPhone2, false)
	h.login(host)

	// Ticked it and then left. Opting out after opting in is the only way round that
	// order can happen, and it is the one the four-state split gets wrong most easily.
	leaving := registerWithPhone(t, h, wb.ID, "Chloe", "chloe@example.com", broadcastPhone3, true)
	h.login(host)
	res, raw := h.do(http.MethodPost, "/api/host/crm/contacts/"+leaving.ID+"/opt-out", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("opt out: status %d body %s", res.StatusCode, raw)
	}

	// No number at all: nothing to send to, and nobody to chase about it either.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Dudu", LastName: "Lead", Email: "dudu@example.com", Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register Dudu: status %d body %s", res.StatusCode, raw)
	}
	h.login(host)
	return wb
}

// wantStatus is the state each of the four is in, by email.
var wantStatus = map[string]string{
	"ayanda@example.com": types.CRMStatusOptedIn,
	"bheki@example.com":  types.CRMStatusNoOptIn,
	"chloe@example.com":  types.CRMStatusOptedOut,
	"dudu@example.com":   types.CRMStatusNoNumber,
}

func TestRegistrantWhatsAppAgreesWithTheCRM(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	const host = "neeraj@acme.dev"
	h.login(host)
	connectWhatsApp(t, h)
	wb := fourStates(t, h, host)

	rows := registrantRows(t, h, wb.ID)
	if len(rows) != 4 {
		t.Fatalf("%d registrant rows, want 4: %+v", len(rows), rows)
	}
	scoped := crmContactsWith(t, h, "?webinarId="+wb.ID)

	for email, want := range wantStatus {
		row := registrantFor(t, rows, email)
		if row.WhatsAppStatus != want {
			t.Errorf("%s: registrant row says %q, want %q", email, row.WhatsAppStatus, want)
		}
		/* The same person, read from the CRM instead. Two queries, one shared predicate:
		 * a host who compares the tab against the inbox must not find two answers. */
		contact := contactFor(t, scoped.Contacts, email)
		if row.LastInboundAt != contact.LastInboundAt {
			t.Errorf("%s: the tab says replied at %q and the CRM says %q",
				email, row.LastInboundAt, contact.LastInboundAt)
		}
		if row.Phone != contact.Phone {
			t.Errorf("%s: the tab has phone %q and the CRM has %q", email, row.Phone, contact.Phone)
		}
	}

	// Only the one who wrote back has a reply time, and it is a time rather than a flag:
	// "replied" three months ago and "replied" this morning are different situations.
	if got := registrantFor(t, rows, "ayanda@example.com"); got.LastInboundAt == "" {
		t.Errorf("Ayanda wrote back and the row says nothing: %+v", got)
	}
	for _, email := range []string{"bheki@example.com", "chloe@example.com", "dudu@example.com"} {
		if got := registrantFor(t, rows, email); got.LastInboundAt != "" {
			t.Errorf("%s never wrote back but the row says %q", email, got.LastInboundAt)
		}
	}
}

/* A registrant who is in no CRM at all reads as empty, not as "has not opted in".
 *
 * The guest door collects a name and nothing else, so there is no contact to have a
 * consent state. Calling that "not opted in" would send the host chasing somebody who
 * was never asked and cannot be — which is why the field is a string and empty is a
 * fourth answer rather than a false.
 */
func TestGuestRegistrantHasNoWhatsAppState(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	wb := h.openWebinar("Guest door, no CRM")

	res, raw := h.guestJoin(wb.ID, "Nomsa Dube")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("guest join: status %d body %s", res.StatusCode, raw)
	}

	rows := registrantRows(t, h, wb.ID)
	if len(rows) != 1 {
		t.Fatalf("%d rows, want the one guest: %+v", len(rows), rows)
	}
	if rows[0].WhatsAppStatus != "" || rows[0].LastInboundAt != "" {
		t.Errorf("a name-only guest carries a WhatsApp state: %+v", rows[0])
	}
	if !rows[0].IsGuest {
		t.Fatalf("fixture is not a guest row: %+v", rows[0]) // then the above proved nothing
	}
}

/* The chips count what the filters return, and each group covers everybody once. */
func TestCRMContactStatusFiltersMatchTheirCounts(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	const host = "neeraj@acme.dev"
	h.login(host)
	connectWhatsApp(t, h)
	wb := fourStates(t, h, host)

	all := crmContactsWith(t, h, "?webinarId="+wb.ID)
	if all.Total != 4 || len(all.Contacts) != 4 {
		t.Fatalf("scoped list: total %d, %d contacts, want 4 of each", all.Total, len(all.Contacts))
	}
	c := all.Counts
	if c.Total != all.Total {
		t.Errorf("counts.total = %d but the list says %d", c.Total, all.Total)
	}

	/* Two partitions, each summing to the total on its own.
	 *
	 * Checked as sums rather than as four separate numbers because the sums are the
	 * property the screen depends on: the chips are rendered as two labelled rows, and a
	 * row whose parts do not add up to the heading is a row the host has to guess at. */
	if got := c.Replied + c.NoReply; got != c.Total {
		t.Errorf("replied %d + noReply %d = %d, want the total %d",
			c.Replied, c.NoReply, got, c.Total)
	}
	if got := c.OptedIn + c.NoOptIn + c.OptedOut + c.NoNumber; got != c.Total {
		t.Errorf("optedIn %d + noOptIn %d + optedOut %d + noNumber %d = %d, want the total %d",
			c.OptedIn, c.NoOptIn, c.OptedOut, c.NoNumber, got, c.Total)
	}

	// And the fixture is in the states the file says it is, so a failure above is about
	// the counting rather than about the setup.
	want := types.CRMContactCounts{
		Total: 4, Replied: 1, NoReply: 3,
		OptedIn: 1, NoOptIn: 1, OptedOut: 1, NoNumber: 1,
	}
	if c != want {
		t.Fatalf("counts = %+v, want %+v", c, want)
	}

	// Every chip: the list it filters to is exactly the people it counted.
	byStatus := map[string][]string{
		types.CRMStatusReplied:  {"ayanda@example.com"},
		types.CRMStatusNoReply:  {"bheki@example.com", "chloe@example.com", "dudu@example.com"},
		types.CRMStatusOptedIn:  {"ayanda@example.com"},
		types.CRMStatusNoOptIn:  {"bheki@example.com"},
		types.CRMStatusOptedOut: {"chloe@example.com"},
		types.CRMStatusNoNumber: {"dudu@example.com"},
	}
	counted := map[string]int{
		types.CRMStatusReplied: c.Replied, types.CRMStatusNoReply: c.NoReply,
		types.CRMStatusOptedIn: c.OptedIn, types.CRMStatusNoOptIn: c.NoOptIn,
		types.CRMStatusOptedOut: c.OptedOut, types.CRMStatusNoNumber: c.NoNumber,
	}
	for _, status := range types.CRMContactStatuses {
		res := crmContactsWith(t, h, "?webinarId="+wb.ID+"&status="+status)
		expect := byStatus[status]
		sort.Strings(expect)
		if got := contactEmails(res.Contacts); !sameEmails(got, expect) {
			t.Errorf("?status=%s returned %v, want %v", status, got, expect)
		}
		if len(res.Contacts) != counted[status] {
			t.Errorf("?status=%s returned %d contacts but its chip counted %d",
				status, len(res.Contacts), counted[status])
		}
		// The echo, so a screen that has been given a URL knows which chip to light up
		// without parsing it again.
		if res.Status != status {
			t.Errorf("?status=%s echoed %q", status, res.Status)
		}
		/* The counts do NOT narrow with the filter: the chips stay where they were while
		 * one of them is active, because a host filtering to "no reply" still needs to
		 * see how many replied in order to come back. */
		if res.Counts != want {
			t.Errorf("?status=%s moved the counts to %+v", status, res.Counts)
		}
		if res.Total != 4 {
			t.Errorf("?status=%s reports total %d, want the scope's 4", status, res.Total)
		}
	}

	/* Unscoped, the same rules hold over the whole CRM — and there is one more contact
	 * here than in the webinar: the inbound message from Ayanda's number is hers, but
	 * every host CRM also accumulates people from other webinars, so this asserts the
	 * partitions rather than the particular numbers. */
	whole := crmContacts(t, h)
	if whole.Counts.Replied+whole.Counts.NoReply != whole.Counts.Total ||
		whole.Counts.OptedIn+whole.Counts.NoOptIn+whole.Counts.OptedOut+
			whole.Counts.NoNumber != whole.Counts.Total {
		t.Errorf("unscoped counts do not partition: %+v", whole.Counts)
	}
	if whole.Counts.Total != whole.Total {
		t.Errorf("unscoped counts.total = %d, list total %d", whole.Counts.Total, whole.Total)
	}

	/* A status nobody defined is refused rather than ignored.
	 *
	 * Ignoring it would answer with the whole list under a heading that names a filter,
	 * which is the one outcome a host cannot detect — and the message names the values
	 * that do work, because whoever hit this was building a link. */
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts?status=ghosted", nil)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "crm_bad_status" {
		t.Fatalf("?status=ghosted: status %d code %q body %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	for _, status := range types.CRMContactStatuses {
		if !strings.Contains(string(raw), status) {
			t.Errorf("the refusal does not name %q: %s", status, raw)
		}
	}
}
