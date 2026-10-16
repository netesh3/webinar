package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The whiteboard is on by default for every host (migrations/0099), and an
 * administrator can turn it off. Only the stage is offered it: the host and their
 * panelists draw, the audience watches. The switch is the HOST's — turning it off
 * for a panelist's own account does not take it away in somebody else's session,
 * and turning it off for the host takes it away from their panelists too.
 */
func TestWhiteboardFollowsTheHostSwitch(t *testing.T) {
	h := newHarness(t)
	h.goLive("scaling-webrtc-10k")

	hostJoin := func(email string) types.JoinResponse {
		t.Helper()
		h.login(email)
		res, raw := h.do(http.MethodPost, "/api/host/webinars/scaling-webrtc-10k/join", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s join: status %d body %s", email, res.StatusCode, raw)
		}
		var join types.JoinResponse
		h.decode(raw, &join)
		return join
	}
	setFeature := func(email string, on bool) {
		t.Helper()
		h.login(email)
		if _, err := h.store.SetFeature(t.Context(), meAccount(t, h).ID, types.FeatureWhiteboard, on); err != nil {
			t.Fatalf("set whiteboard=%v for %s: %v", on, email, err)
		}
	}

	// On by default, for the host and for a panelist.
	if !hostJoin("neeraj@acme.dev").Whiteboard {
		t.Fatal("host not offered the whiteboard by default")
	}
	if !hostJoin("priya@acme.dev").Whiteboard {
		t.Fatal("panelist not offered the whiteboard by default")
	}

	// A panelist's own switch does not count: it is the host's session.
	setFeature("priya@acme.dev", false)
	if !hostJoin("priya@acme.dev").Whiteboard {
		t.Fatal("panelist's own switch took the whiteboard away in someone else's session")
	}

	// The host's switch off: neither host nor panelist gets it.
	setFeature("neeraj@acme.dev", false)
	if hostJoin("neeraj@acme.dev").Whiteboard {
		t.Fatal("host offered the whiteboard with the switch turned off")
	}
	if hostJoin("priya@acme.dev").Whiteboard {
		t.Fatal("panelist offered the whiteboard with the host's switch turned off")
	}

	// Back on, and never the audience.
	setFeature("neeraj@acme.dev", true)
	h.logout()
	reg := h.registerAs("scaling-webrtc-10k", "wb-attendee@test.dev")
	res, raw := h.do(http.MethodPost, "/api/webinars/scaling-webrtc-10k/join",
		types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("attendee join: status %d body %s", res.StatusCode, raw)
	}
	var att types.JoinResponse
	h.decode(raw, &att)
	if att.Whiteboard {
		t.Fatal("attendee offered the whiteboard")
	}
}
