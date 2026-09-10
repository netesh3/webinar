package api_test

/* One host must never reach another host's webinar.
 *
 * The rule is enforced structurally — requireOwnership wraps the whole
 * /api/host/webinars/{slug} subtree, so no individual handler has to remember it — and
 * api_test.go already proves it on three routes. Three of about thirty.
 *
 * The gap that leaves is not "the middleware might be wrong". It is that somebody adds a
 * host route next month and registers it one level too high, outside the guarded group,
 * and every existing test still passes. That is the realistic way this breaks, and a
 * hand-written list of routes to check cannot catch it: the list is exactly the thing
 * that would not get updated.
 *
 * So these tests WALK THE REAL ROUTE TABLE. Every route chi knows about under
 * /api/host/webinars/{slug} is called as the wrong user and must be refused. A new route
 * is covered the moment it is registered, and a route registered outside the guard fails
 * here rather than in production.
 *
 * Two different wrong users, because the requirement has two halves:
 *
 *   a stranger    hosts something else, not a panelist here      → refused everywhere
 *   a panelist    assigned to this webinar, does not own it      → may join and record,
 *                                                                  may not manage
 */

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

/* Seeded fixtures this file relies on, from store.SeedDev:
 *
 *   simulive-playbook          host lucia@cabify.com,    panelist amara@paystack.com
 *   postgres-event-platforms   host marco@streamline.io, panelist neeraj@acme.dev
 *   scaling-webrtc-10k         host neeraj@acme.dev
 *
 * So neeraj@acme.dev is a real host with real webinars of his own — which is the
 * interesting attacker, not an anonymous caller. He is a stranger to simulive-playbook
 * and a panelist on postgres-event-platforms.
 */
const (
	strangersWebinar = "simulive-playbook"
	strangersTopic   = "The simulive playbook"
	panelistWebinar  = "postgres-event-platforms"
	otherHost        = "neeraj@acme.dev"
)

type route struct {
	method  string
	pattern string
}

// hostWebinarRoutes returns every route chi has registered under the per-webinar host
// subtree, read from the router the server is actually serving.
func hostWebinarRoutes(t *testing.T, h *harness) []route {
	t.Helper()

	routes, ok := h.handler.(chi.Routes)
	if !ok {
		t.Fatalf("router does not implement chi.Routes (%T); cannot enumerate routes", h.handler)
	}

	const prefix = "/api/host/webinars/{slug}"
	var found []route
	err := chi.Walk(routes, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(pattern, prefix) {
			return nil
		}
		// chi reports the subtree root as ".../{slug}/*" or ".../{slug}/" depending on how
		// it was mounted. Normalise to one form so the request path is well-formed.
		pattern = strings.TrimSuffix(pattern, "/*")
		if pattern != prefix {
			pattern = strings.TrimSuffix(pattern, "/")
		}
		found = append(found, route{method: method, pattern: pattern})
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(found) < 20 {
		// A canary. If a refactor moves the subtree and the prefix stops matching, every
		// assertion below would vacuously pass on an empty list.
		t.Fatalf("only found %d routes under %s; the walk is probably matching the wrong prefix", len(found), prefix)
	}
	return found
}

// path fills a route pattern in for a given webinar. The placeholder values are
// deliberately nonsense: authorization must be decided from the SLUG alone, long before
// anything tries to resolve a poll or a participant id.
func (r route) path(slug string) string {
	p := strings.ReplaceAll(r.pattern, "{slug}", slug)
	p = strings.ReplaceAll(p, "{id}", "00000000-0000-0000-0000-000000000000")
	p = strings.ReplaceAll(p, "{userID}", "00000000-0000-0000-0000-000000000000")
	p = strings.ReplaceAll(p, "{identity}", "someone-else")
	return p
}

/* refused asserts that a response is a refusal AND that it says nothing.
 *
 * The status is the smaller half of this. 404 rather than 403 is deliberate in
 * requireOwnership — telling a stranger "403, you may not see this webinar" confirms the
 * webinar exists, which is itself a disclosure. The body check is the half that catches
 * the leak a status code cannot: a handler that authorizes correctly and then includes
 * the row in its error payload.
 */
func refused(t *testing.T, what string, res *http.Response, raw []byte) {
	t.Helper()
	if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
		t.Errorf("%s: status %d, want 403 or 404\n  body: %s", what, res.StatusCode, raw)
		return
	}
	if strings.Contains(string(raw), strangersTopic) {
		t.Errorf("%s: refused with %d but leaked the webinar's topic\n  body: %s",
			what, res.StatusCode, raw)
	}
}

// TestStrangerIsRefusedOnEveryHostRoute is the exhaustive version of
// TestHostCannotTouchAnotherHostsWebinar: same claim, every route.
func TestStrangerIsRefusedOnEveryHostRoute(t *testing.T) {
	h := newHarness(t)
	h.login(otherHost)

	routes := hostWebinarRoutes(t, h)
	t.Logf("checking %d host routes against a webinar the caller does not own", len(routes))

	for _, rt := range routes {
		p := rt.path(strangersWebinar)
		res, raw := h.do(rt.method, p, nil)
		refused(t, rt.method+" "+p, res, raw)
	}
}

/* TestStrangerIsRefusedOnTheRoutesWithoutASlug covers what the walk above cannot.
 *
 * Two host routes do not carry {slug} in the URL, so they sit outside the guarded subtree
 * and authorize themselves. They are the routes most likely to be got wrong, precisely
 * because the middleware is not doing it for them.
 */
func TestStrangerIsRefusedOnTheRoutesWithoutASlug(t *testing.T) {
	h := newHarness(t)

	/* Put a registration on somebody else's webinar, rather than hoping the fixture has
	 * one. An earlier version of this test skipped when the seed happened to have none,
	 * which is the worst outcome available: a green run that asserted nothing. */
	res, raw := h.do(http.MethodPost, "/api/webinars/"+strangersWebinar+"/register", map[string]any{
		"firstName": "Isolation",
		"lastName":  "Fixture",
		"email":     "isolation-fixture@example.invalid",
		"phone":     "+919876500001",
		"consent":   true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("seeding a registration: status %d body %s, want 201", res.StatusCode, raw)
	}

	// Read the id back as the webinar's real owner. There is deliberately no other way to
	// learn a registration id, which is itself part of the defence being tested.
	h.login("lucia@cabify.com")
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+strangersWebinar+"/registrants", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("owner reading her own registrants: status %d body %s", res.StatusCode, raw)
	}
	var registrants []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &registrants); err != nil {
		t.Fatalf("decode registrants: %v (body %s)", err, raw)
	}
	if len(registrants) == 0 {
		t.Fatal("registered an attendee but the owner's registrant list is empty")
	}
	victim := registrants[0].ID

	// Now as the wrong host, with a VALID body. An invalid one would be rejected by the
	// decoder before authorization is ever reached, which would make this test pass for
	// the wrong reason — handleSetRegistrationState validates the payload first and
	// checks ownership second.
	h.login(otherHost)
	res, raw = h.do(http.MethodPatch, "/api/host/registrations/"+victim,
		map[string]string{"state": "approved"})
	refused(t, "PATCH a foreign host's registration", res, raw)

	// And the list endpoint: his own webinars only, never hers.
	_, raw = h.do(http.MethodGet, "/api/host/webinars", nil)
	if strings.Contains(string(raw), strangersTopic) {
		t.Errorf("GET /api/host/webinars leaked another host's webinar\n  body: %s", raw)
	}
}

/* TestNoListEndpointLeaksAForeignWebinar draws the line the access rule actually needs.
 *
 * The host subtree is covered above. This covers everything else a signed-in host can
 * reach, because that is where the real gap was: /api/webinars used to be an open
 * catalogue and returned every scheduled webinar on the server to anybody at all. A host
 * in their own portal could read another host's topic, agenda and registrant count, which
 * is exactly what the rule forbids — and it was enumerable, which is worse than leaky.
 *
 * The boundary now has a deliberate asymmetry, and it is written down here so that neither
 * half gets "fixed" by accident:
 *
 *   LIST endpoints          scoped. Nothing you are not involved in, ever.
 *   ONE webinar BY SLUG     public. A registration link forwarded to somebody with no
 *                           account has to open, or nobody can ever sign up.
 *
 * So knowing a slug is the price of seeing a webinar. That is a weak secret and it is the
 * intended one — it is how every "you're invited" link works. What it is not is a list.
 */
func TestNoListEndpointLeaksAForeignWebinar(t *testing.T) {
	h := newHarness(t)
	h.login(otherHost) // a real host, with real webinars, uninvolved in strangersWebinar

	for _, ep := range []struct {
		method, path, what string
	}{
		{http.MethodGet, "/api/webinars", "the webinar list"},
		{http.MethodGet, "/api/me/registrations", "this account's registrations"},
		{http.MethodGet, "/api/host/webinars", "the host's own webinars"},
		{http.MethodGet, "/api/host/stage", "webinars this account presents on"},
	} {
		res, raw := h.do(ep.method, ep.path, nil)
		if res.StatusCode != http.StatusOK {
			t.Errorf("%s (%s): status %d body %s, want 200", ep.path, ep.what, res.StatusCode, raw)
			continue
		}
		if strings.Contains(string(raw), strangersTopic) {
			t.Errorf("%s (%s) leaked another host's webinar\n  body: %s", ep.path, ep.what, raw)
		}
	}

	// The join-key lookup, holding no keys, must not become a way to list anything.
	res, raw := h.do(http.MethodPost, "/api/registrations/lookup",
		map[string][]string{"joinKeys": {"NOPENOPENOPE"}})
	if res.StatusCode != http.StatusOK {
		t.Errorf("lookup with an unknown key: status %d body %s, want 200", res.StatusCode, raw)
	} else if strings.Contains(string(raw), strangersTopic) {
		t.Errorf("lookup leaked a webinar for a key the caller does not hold\n  body: %s", raw)
	}

	/* And the deliberate exception, asserted so it cannot be silently closed.
	 *
	 * If this ever starts returning 401, every invitation link already sent has stopped
	 * working — a much worse failure than the leak that was being fixed, and one that
	 * would look like "registration is broken" rather than like a security change.
	 */
	res, raw = h.do(http.MethodGet, "/api/webinars/"+strangersWebinar, nil)
	if res.StatusCode != http.StatusOK {
		t.Errorf("a known slug must stay publicly readable or registration links die: status %d body %s",
			res.StatusCode, raw)
	}
}

/* TestPanelistCanReachTheStageButNotManageIt is the "or are assigned to" half.
 *
 * An assigned panelist is not a stranger — they legitimately need the room, and they
 * appear in their own /api/host/stage list. What they must not get is management: the
 * whole requireOwnership subtree stays shut to them.
 *
 * Worth stating why this is not paranoia. requireStage exists so a guest speaker can
 * record their own section, and it is a genuinely wider door than requireOwnership. Any
 * future route put behind the wrong one of those two middlewares is a privilege
 * escalation, and this is the test that notices.
 */
func TestPanelistCanReachTheStageButNotManageIt(t *testing.T) {
	h := newHarness(t)
	h.login(otherHost) // a panelist on panelistWebinar, not its host

	// The stage, which they are entitled to.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+panelistWebinar+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("panelist join: status %d body %s, want 200", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+panelistWebinar+"/recordings", nil)
	if res.StatusCode != http.StatusOK {
		t.Errorf("panelist listing recordings: status %d body %s, want 200", res.StatusCode, raw)
	}

	// Everything else. Management routes are the ones under requireOwnership, so the
	// walk gives them; join and the recording endpoints are the deliberate exceptions.
	stage := map[string]bool{"/join": true, "/recordings": true}
	isStageRoute := func(pattern string) bool {
		tail := strings.TrimPrefix(pattern, "/api/host/webinars/{slug}")
		for prefix := range stage {
			if strings.HasPrefix(tail, prefix) {
				return true
			}
		}
		return false
	}

	checked := 0
	for _, rt := range hostWebinarRoutes(t, h) {
		if isStageRoute(rt.pattern) {
			continue
		}
		p := rt.path(panelistWebinar)
		res, raw := h.do(rt.method, p, nil)
		if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
			t.Errorf("panelist reached a management route: %s %s -> %d\n  body: %s",
				rt.method, p, res.StatusCode, raw)
		}
		checked++
	}
	if checked < 15 {
		t.Fatalf("only checked %d management routes; the stage filter is too broad", checked)
	}
}
