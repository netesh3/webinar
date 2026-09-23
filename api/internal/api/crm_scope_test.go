package api_test

import (
	"net/http"
	"sort"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Narrowing the CRM to one webinar's registrants — the "View in CRM" link.
 *
 * Three claims, and the last two are the ones worth the file:
 *
 *  1. The scope selects this webinar's people and only them, including through the
 *     search box. A filter a search can reach around is not a filter.
 *  2. A slug that is not the caller's is REFUSED, not quietly answered with the zero
 *     contacts the query would honestly find. The two look identical on screen and
 *     mean opposite things.
 *  3. The scoped list and the broadcast audience for the same webinar are the same
 *     set of people. They share one SQL predicate precisely so that they cannot
 *     drift, and this is the test that notices if somebody copies it.
 */

// registerLead registers one person, with their own number, for one webinar — then
// logs the host back in, because registering replaces the session cookie.
//
// Its own number per person on purpose: registerGuest in approvals_test.go reuses one
// number for everybody, and the CRM matches a contact by phone OR email, so two of
// those are one contact. Correct, and useless for counting people across webinars.
func registerLead(t *testing.T, h *harness, host, slug, name, email, phone string) {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+slug+"/register", types.RegisterRequest{
		FirstName: name, LastName: "Lead", Email: email, Phone: phone, Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register %s for %s: status %d body %s", email, slug, res.StatusCode, raw)
	}
	h.login(host)
}

// crmContactsWith reads the contacts list with a query string, expecting 200.
func crmContactsWith(t *testing.T, h *harness, qs string) types.CRMContactsResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/crm/contacts"+qs, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("contacts%s: status %d body %s", qs, res.StatusCode, raw)
	}
	var out types.CRMContactsResponse
	h.decode(raw, &out)
	return out
}

// contactEmails is the list as a set the test can state its expectation about,
// sorted because "who is in this list" is the claim and their order is not.
func contactEmails(contacts []types.CRMContact) []string {
	out := make([]string, 0, len(contacts))
	for _, c := range contacts {
		out = append(out, c.Email)
	}
	sort.Strings(out)
	return out
}

func sameEmails(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

/* The scope selects one webinar's registrants, and the search box works inside it.
 *
 * The third person registers for both webinars and must appear under both — one
 * person is one contact with one conversation, and a webinar's view of them is a
 * filter over that, not a copy of it.
 */
func TestCRMContactsScopeToOneWebinar(t *testing.T) {
	h := newHarness(t)
	const host = "neeraj@acme.dev"
	h.login(host)
	first := autoWebinar(t, h, "Pricing teardown")
	second := autoWebinar(t, h, "Migration clinic")

	registerLead(t, h, host, first.ID, "Ayanda", "ayanda@example.com", "+27831110001")
	registerLead(t, h, host, second.ID, "Bheki", "bheki@example.com", "+27831110002")
	registerLead(t, h, host, first.ID, "Chloe", "chloe@example.com", "+27831110003")
	registerLead(t, h, host, second.ID, "Chloe", "chloe@example.com", "+27831110003")

	// Three people, four registrations.
	if all := crmContacts(t, h); all.Total != 3 || len(all.Contacts) != 3 {
		t.Fatalf("unscoped: total %d, %d contacts, want 3 of each", all.Total, len(all.Contacts))
	} else if all.Scope != nil {
		t.Errorf("unscoped list carries a scope: %+v", all.Scope)
	}

	scoped := crmContactsWith(t, h, "?webinarId="+first.ID)
	if got, want := contactEmails(scoped.Contacts), []string{"ayanda@example.com", "chloe@example.com"}; !sameEmails(got, want) {
		t.Errorf("first webinar's contacts = %v, want %v", got, want)
	}
	// Counted through the scope: the heading says how many people are in the list
	// being looked at, and "2 of your contacts" under a list of 2 is the only
	// number a host can check.
	if scoped.Total != 2 {
		t.Errorf("scoped total = %d, want 2", scoped.Total)
	}
	if scoped.Scope == nil {
		t.Fatal("scoped list carries no scope — the heading would have nothing to name")
	}
	if scoped.Scope.WebinarID != first.ID || scoped.Scope.Topic != first.Topic {
		t.Errorf("scope = %+v, want %s / %q", scoped.Scope, first.ID, first.Topic)
	}

	other := crmContactsWith(t, h, "?webinarId="+second.ID)
	if got, want := contactEmails(other.Contacts), []string{"bheki@example.com", "chloe@example.com"}; !sameEmails(got, want) {
		t.Errorf("second webinar's contacts = %v, want %v", got, want)
	}

	/* The search runs INSIDE the scope. A search that reached past it would be the
	 * whole CRM one keystroke away from a list the host was told was one webinar's —
	 * and the tags and notes they apply from here would land on the wrong people.
	 */
	if res := crmContactsWith(t, h, "?webinarId="+first.ID+"&q=bheki"); len(res.Contacts) != 0 {
		t.Errorf("searching the first webinar for the second's registrant found %v",
			contactEmails(res.Contacts))
	}
	if res := crmContactsWith(t, h, "?webinarId="+first.ID+"&q=chloe"); len(res.Contacts) != 1 {
		t.Errorf("searching inside the scope for somebody in it found %d, want 1", len(res.Contacts))
	}
	// And the total does not move when the box is typed in: it describes the list,
	// not the search results.
	if res := crmContactsWith(t, h, "?webinarId="+first.ID+"&q=chloe"); res.Total != 2 {
		t.Errorf("total = %d while searching, want the scope's 2", res.Total)
	}
}

/* A slug that is not the caller's is refused.
 *
 * The failure this guards against is the quiet one. The SQL requires the webinar's
 * host to be the contact's, so a foreign slug already selects nobody — which means a
 * missing ownership check would not leak a single row, and would instead tell the
 * host that nobody registered for a webinar of theirs they are looking straight at.
 * That is indistinguishable from the truth, which is what makes it worth a test.
 */
func TestCRMWebinarScopeRefusesAWebinarThatIsNotYours(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	mine := autoWebinar(t, h, "Not yours")
	registerLead(t, h, "neeraj@acme.dev", mine.ID, "Dudu", "dudu@example.com", "+27831110004")

	// The control: it works for the owner.
	if res := crmContactsWith(t, h, "?webinarId="+mine.ID); len(res.Contacts) != 1 {
		t.Fatalf("owner sees %d contacts, want 1 — the rest of this test proves nothing",
			len(res.Contacts))
	}

	h.logout()
	h.login("lucia@cabify.com")
	otherHost := autoWebinar(t, h, "Lucia's own")
	registerLead(t, h, "lucia@cabify.com", otherHost.ID, "Elena", "elena@example.com", "+27831110005")

	for _, slug := range []string{mine.ID, "no-such-webinar"} {
		res, raw := h.do(http.MethodGet, "/api/host/crm/contacts?webinarId="+slug, nil)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("?webinarId=%s: status %d, want 404\n  body: %s", slug, res.StatusCode, raw)
		}
	}
	// And the refusal did not cost them their own list.
	if res := crmContactsWith(t, h, "?webinarId="+otherHost.ID); len(res.Contacts) != 1 {
		t.Errorf("own scoped list has %d contacts after the refusals, want 1", len(res.Contacts))
	}
}

/* The scoped list and the broadcast audience are the same people.
 *
 * Both answer "who registered for this webinar" and they share one predicate so that
 * they always agree — see store.contactRegisteredFor. A host who reads "3 people" on
 * the contacts list and then sees a broadcast to 2 of them has been given two facts
 * and no way to choose between them.
 *
 * The declined registrant is the interesting row, because this is where the two
 * screens could plausibly have been written differently: the webinar's own Attendees
 * tab DOES show them. Excluded in the CRM, in both places, by one rule.
 */
func TestCRMWebinarScopeAndBroadcastAudienceAgree(t *testing.T) {
	h := newHarness(t)
	const host = "neeraj@acme.dev"
	h.login(host)
	wb := manualWebinar(t, h, "Reviewed by hand")

	registerLead(t, h, host, wb.ID, "Farai", "farai@example.com", "+27831110006")
	registerLead(t, h, host, wb.ID, "Gugu", "gugu@example.com", "+27831110007")
	registerLead(t, h, host, wb.ID, "Hope", "hope@example.com", "+27831110008")

	// Decline one of the three. Pending is left alone deliberately: somebody waiting
	// on the host's decision still asked to hear about this webinar.
	declined := idOf(t, h, wb.ID, "hope@example.com")
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{IDs: []string{declined}, State: types.RegDeclined})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("decline: status %d body %s", res.StatusCode, raw)
	}

	scoped := crmContactsWith(t, h, "?webinarId="+wb.ID)
	if got, want := contactEmails(scoped.Contacts), []string{"farai@example.com", "gugu@example.com"}; !sameEmails(got, want) {
		t.Errorf("scoped contacts = %v, want %v — a declined seat is not this webinar's audience", got, want)
	}

	/* The four buckets are disjoint and cover the audience, so their sum is how many
	 * people it holds. Comparing the sum rather than one bucket is the point: the
	 * question is whether the two screens see the same PEOPLE, not whether they agree
	 * about who has opted in.
	 */
	counts := audiencePreview(t, h, "?audience=webinar&webinarId="+wb.ID)
	inAudience := counts.Recipients + counts.NoOptIn + counts.OptedOut + counts.NoNumber
	if inAudience != scoped.Total {
		t.Errorf("audience holds %d people (%+v) and the scoped list %d — the same "+
			"question answered twice", inAudience, counts, scoped.Total)
	}
	// All three contacts are still in the CRM. The scope hides the declined one from
	// this webinar's view of the list; it does not delete anybody.
	if all := crmContacts(t, h); all.Total != 3 {
		t.Errorf("unscoped total = %d, want 3 — declining a seat must not remove a contact", all.Total)
	}
}
