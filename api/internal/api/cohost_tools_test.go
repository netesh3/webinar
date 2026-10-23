package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* A co-host gets the host's tools, whether or not their own account can host (api.go: the
 * per-webinar subtree is outside requireHost), and the owner-only actions stay the owner's. */
func TestCoHostWithoutHostingGetsHostTools(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Owner Asha", "owner-asha@test.dev", true)
	// Guest speakers: accounts with no hosting capability, the usual panelist.
	guest := h.signup("Guest Ravi", "guest-ravi@test.dev", false)
	other := h.signup("Guest Mira", "guest-mira@test.dev", false)
	h.login(host.Email)
	wb := h.newWebinar("Co-host tools", nil)
	for _, email := range []string{guest.Email, other.Email} {
		if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/panelists", types.PanelistRequest{Email: email}); res.StatusCode != http.StatusOK {
			t.Fatalf("add panelist: %d %s", res.StatusCode, raw)
		}
	}

	participants := "/api/host/webinars/" + wb.ID + "/participants"

	// An ordinary panelist is not a host.
	h.login(guest.Email)
	if res, _ := h.do(http.MethodGet, participants, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("a plain panelist read the participants: %d", res.StatusCode)
	}

	h.login(host.Email)
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/panelists/"+guest.ID+"/co-host", types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host: %d %s", res.StatusCode, raw)
	}

	h.login(guest.Email)
	for _, path := range []string{participants, "/api/host/webinars/" + wb.ID, "/api/host/webinars/" + wb.ID + "/polls"} {
		if res, raw := h.do(http.MethodGet, path, nil); res.StatusCode != http.StatusOK {
			t.Errorf("co-host without hosting, GET %s: %d %s", path, res.StatusCode, raw)
		}
	}
	// A co-host may make another panelist co-host.
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/panelists/"+other.ID+"/co-host", types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Errorf("co-host promotes a panelist: %d %s", res.StatusCode, raw)
	}
	// But never the owner's own actions.
	res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil)
	h.wantError(res, raw, http.StatusForbidden, "host_only")
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/followups/send", map[string]any{})
	h.wantError(res, raw, http.StatusForbidden, "host_only")
	// Nor hosting in their own name: the account-level host routes still need the capability.
	res, raw = h.do(http.MethodGet, "/api/host/webinars", nil)
	h.wantError(res, raw, http.StatusForbidden, "not_a_host")

	// Taken back: the door closes again.
	h.login(host.Email)
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/panelists/"+guest.ID+"/co-host", types.CoHostPatch{CoHost: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("revoke co-host: %d %s", res.StatusCode, raw)
	}
	h.login(guest.Email)
	if res, _ := h.do(http.MethodGet, participants, nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("a revoked co-host read the participants: %d", res.StatusCode)
	}

	// The owner still needs the hosting capability, as before.
	if _, err := h.store.SetHostCapability(context.Background(), host.ID, false); err != nil {
		t.Fatal(err)
	}
	h.login(host.Email)
	res, raw = h.do(http.MethodGet, participants, nil)
	h.wantError(res, raw, http.StatusForbidden, "not_a_host")
}

/* The host's camera never goes out over the replay: the host team joins a playing simulive
 * with no media, and only "End replay early and go live" (or the recording's end) puts them
 * on a publishing stage — still never recorded. */
func TestSimuliveGoLiveEarly(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Early Live", "early-live@test.dev", true)
	sim := lazySimulive(t, h, 20*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})

	// Not started: nothing to go live from.
	res, _, raw := h.simuliveControl(http.MethodPost, sim.ID, "go-live", nil)
	h.wantError(res, raw, http.StatusConflict, "not_live")

	if res, _, raw := h.simuliveControl(http.MethodPost, sim.ID, "start-now", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("start now: %d %s", res.StatusCode, raw)
	}
	guest := h.registerAsGuest(sim.ID, "early-live-viewer@test.dev")

	// While it plays: no media for the host, the recording for the audience.
	if hj := h.hostJoinSimulive(sim.ID); !hj.Simulive || hj.CanPublish || hj.CanRecord || h.rooms.lastSpec.NoMedia != true {
		t.Fatalf("host join while it plays: %+v (spec %+v)", hj, h.rooms.lastSpec)
	}
	if _, gj, _ := h.joinAsGuestKey(sim.ID, guest.JoinKey); !gj.Simulive || !gj.CdnBroadcast {
		t.Fatalf("guest join while it plays: %+v", gj)
	}

	res, wb, raw := h.simuliveControl(http.MethodPost, sim.ID, "go-live", nil)
	if res.StatusCode != http.StatusOK || wb.Status != types.StatusLive || wb.SimuliveLiveAt == "" {
		t.Fatalf("go live: %d %s", res.StatusCode, raw)
	}
	if meta := h.roomMeta(sim.ID); !strings.Contains(meta, `"simuliveLiveAt"`) {
		t.Errorf("the room was not told: %s", meta)
	}
	// Again answers as it is.
	if res, again, raw := h.simuliveControl(http.MethodPost, sim.ID, "go-live", nil); res.StatusCode != http.StatusOK || again.SimuliveLiveAt != wb.SimuliveLiveAt {
		t.Fatalf("go live twice: %d %s", res.StatusCode, raw)
	}

	// The host re-joins on a publishing stage; the recording is still refused.
	hj := h.hostJoinSimulive(sim.ID)
	if hj.Simulive || !hj.SimuliveLive || !hj.CanPublish || hj.CanRecord || h.rooms.lastSpec.NoMedia {
		t.Fatalf("host join after go live: %+v", hj)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+sim.ID+"/recordings", types.StartRecordingRequest{Mime: "video/webm"})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "simulive_not_recordable")

	// The audience is in the ordinary live room now, not on the recording.
	res, gj, raw := h.joinAsGuestKey(sim.ID, guest.JoinKey)
	if res.StatusCode != http.StatusOK || gj.Simulive || gj.CdnBroadcast || !gj.SimuliveLive {
		t.Fatalf("guest join after go live: %d %s", res.StatusCode, raw)
	}

	// A plain panelist cannot end the replay.
	h.signup("Plain Speaker", "plain-speaker-golive@test.dev", false)
	res, _, _ = h.simuliveControl(http.MethodPost, sim.ID, "go-live", nil)
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("a stranger: %d", res.StatusCode)
	}
}

/* A co-host in a playing simulive: the participants list, and still no media of their own. */
func TestSimuliveCoHostSeesParticipantsWithoutMedia(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Coach Roster", "roster-coach@test.dev", true)
	sim := lazySimulive(t, h, -30*time.Second, nil)
	co := h.signup("Co Roster", "co-roster@test.dev", false)
	h.login(host.Email)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+sim.ID+"/panelists", types.PanelistRequest{Email: co.Email}); res.StatusCode != http.StatusOK {
		t.Fatalf("add panelist: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+sim.ID+"/panelists/"+co.ID+"/co-host", types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("make co-host in a simulive: %d %s", res.StatusCode, raw)
	}
	h.login(co.Email)
	hj := h.hostJoinSimulive(sim.ID)
	if !hj.Simulive || hj.CanPublish || !h.rooms.lastSpec.NoMedia || !h.rooms.lastSpec.CoHost {
		t.Fatalf("co-host join while it plays: %+v (spec %+v)", hj, h.rooms.lastSpec)
	}
	h.setRoster(types.LiveParticipant{Identity: "att_x", Name: "Viewer", Role: types.RoleAttendee})
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+sim.ID+"/participants", nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "att_x") {
		t.Fatalf("co-host participants: %d %s", res.StatusCode, raw)
	}
}
