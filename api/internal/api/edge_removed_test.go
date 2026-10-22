package api_test

import (
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* A removed edge viewer stays out on every automatic way back.
 *
 * instant-webinar-4277: the stream refused a removed viewer (403), the browser joined again
 * for a fresh token, the join said yes, and the new token was refused in turn — 181 times.
 * Every door a browser opens by itself now says 403 removed: the stream, the beat, the
 * automatic join (rejoin=1, which the browser's token refresh is), the rejoin cookie and the
 * rejoin check. Pressing Join with the link is still a deliberate return, as for any webinar,
 * but the stream it leads to refuses them, and the browser stops there (web/lib/edge-route.ts). */
func TestRemovedEdgeViewerIsRefusedOnEveryAutomaticPath(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "edge-removed@test.dev")
	// She is not on the video server, as an edge viewer never is: Remove takes the edge path.
	h.rooms.mu.Lock()
	h.rooms.strictRoster = true
	h.rooms.mu.Unlock()
	wb := edgeWebinar(h, "Edge removed")
	alice := h.registerAsGuest(wb.ID, "edge-removed-alice@test.dev")

	// Her browser joins with the key, which leaves the rejoin cookie.
	g := newBrowser(t, h)
	res, raw := g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: alice.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	var aj types.JoinResponse
	h.decode(raw, &aj)
	cookie := g.rejoinCookie(wb.ID)
	if aj.Delivery != types.DeliveryEdge || aj.EventsToken == "" || cookie == nil {
		t.Fatalf("edge join: %+v, cookie %v", aj, cookie)
	}
	ev, _, cancel := h.openEvents(wb.ID, aj.EventsToken)
	defer cancel()
	waitFor(t, ev, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })

	if res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID+"/participants/"+aj.Identity, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("remove: %d %s", res.StatusCode, raw)
	}
	cancel()

	refused := func(what string, res *http.Response, raw []byte) {
		t.Helper()
		if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "removed" {
			t.Fatalf("%s after removal: %d %s, want 403 removed", what, res.StatusCode, raw)
		}
	}
	send := func(method, path string) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest(method, h.srv.URL+path, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res, raw
	}
	base := "/api/webinars/" + wb.ID + "/events"

	res, raw = send(http.MethodGet, base+"?t="+aj.EventsToken)
	refused("event stream", res, raw)

	res, raw = send(http.MethodPost, base+"/beat?t="+aj.EventsToken)
	refused("beat", res, raw)
	if n := edgeViewers(t, h, wb.ID); n != 0 {
		t.Fatalf("a removed viewer's beat reopened her seat: %d viewers", n)
	}

	// Presence over the API (presence.go) is no way back onto the roster either.
	res, raw = g.post("/api/webinars/"+wb.ID+"/presence", types.PresenceRequest{JoinKey: alice.JoinKey})
	refused("presence", res, raw)

	// The browser's token refresh is an automatic join, by key.
	res, raw = g.post("/api/webinars/"+wb.ID+"/join?rejoin=1", types.JoinRequest{JoinKey: alice.JoinKey})
	refused("automatic join by key", res, raw)
	if g.rejoinCookie(wb.ID) != nil {
		t.Fatal("the refusal left the rejoin cookie in place")
	}

	// The rejoin cookie on its own, in a browser that still has it.
	g2 := newBrowser(t, h)
	u, _ := url.Parse(h.srv.URL + "/api/webinars/" + wb.ID + "/join")
	g2.jar.SetCookies(u, []*http.Cookie{{Name: cookie.Name, Value: cookie.Value}})
	if g2.rejoinCookie(wb.ID) == nil {
		t.Fatal("precondition: the second browser should hold the cookie")
	}
	res, raw = g2.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
	refused("rejoin cookie", res, raw)
	if got := g.check(wb.ID, alice.JoinKey); got.Rejoin || got.Reason != "removed" {
		t.Fatalf("rejoin-check after removal = %+v", got)
	}

	// Pressing Join is deliberate and still answers; the stream it leads to does not.
	res, raw = g.post("/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: alice.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("deliberate join after removal: %d %s", res.StatusCode, raw)
	}
	var again types.JoinResponse
	h.decode(raw, &again)
	res, raw = send(http.MethodGet, base+"?t="+again.EventsToken)
	refused("event stream on a fresh token", res, raw)
}
