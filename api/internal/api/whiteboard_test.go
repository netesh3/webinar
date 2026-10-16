package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The whiteboard is off until an admin turns it on for the host, and even then
 * only the stage is offered it: the host and their panelists draw, the audience
 * watches. The switch is the HOST's — a panelist on a host who has it gets the
 * whiteboard, a host without it cannot be routed around by a panelist who has it.
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

	// Off by default, for the host and for a panelist.
	if hostJoin("neeraj@acme.dev").Whiteboard {
		t.Fatal("host offered the whiteboard with the switch off")
	}
	if hostJoin("priya@acme.dev").Whiteboard {
		t.Fatal("panelist offered the whiteboard with the host's switch off")
	}

	// A panelist's own switch does not count: it is the host's session.
	h.login("priya@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhiteboard)
	if hostJoin("priya@acme.dev").Whiteboard {
		t.Fatal("panelist's own switch turned the whiteboard on in someone else's session")
	}

	// The host's switch on: host and panelist both get it.
	h.login("neeraj@acme.dev")
	grantFeature(t, h, meAccount(t, h).ID, types.FeatureWhiteboard)
	if !hostJoin("neeraj@acme.dev").Whiteboard {
		t.Fatal("host not offered the whiteboard with the switch on")
	}
	if !hostJoin("priya@acme.dev").Whiteboard {
		t.Fatal("panelist not offered the whiteboard with the host's switch on")
	}

	// Never the audience.
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
