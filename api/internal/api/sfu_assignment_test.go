package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Per-host video server (users.sfu_project): an admin can send one host's NEW webinars to a
 * particular LiveKit project (a second SFU). Everything else is the existing pin: a room never
 * moves once it has one. */

func hostID(t *testing.T, h *harness, email string) string {
	t.Helper()
	u, err := h.store.UserByEmail(context.Background(), email)
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func TestAHostsNewWebinarsGoToTheirAssignedProject(t *testing.T) {
	second := newFakeProject("second")
	h := newHarnessWith(t, []*fakeRooms{second})
	h.login("neeraj@acme.dev")
	host := hostID(t, h, "neeraj@acme.dev")

	// Pinned before the assignment: stays where it is.
	before := h.openWebinar("Before the assignment")
	if res, raw := h.guestJoin(before.ID, "Early"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(before.ID); got != "test" {
		t.Fatalf("default pin = %q, want test", got)
	}

	if err := h.store.SetUserSFUProject(context.Background(), host, "second"); err != nil {
		t.Fatal(err)
	}
	if res, raw := h.guestJoin(before.ID, "Late"); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(before.ID); got != "test" {
		t.Errorf("an assignment moved an already-pinned webinar to %q", got)
	}

	after := h.openWebinar("After the assignment")
	if res, raw := h.guestJoin(after.ID, "Newcomer"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(after.ID); got != "second" {
		t.Errorf("new webinar pinned to %q, want the assigned second", got)
	}

	// Disabled: the assignment no longer applies to new rooms; pinned ones keep working.
	h.pool.enabled["second"] = false
	next := h.openWebinar("Assigned project disabled")
	if res, raw := h.guestJoin(next.ID, "Guest"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(next.ID); got != "test" {
		t.Errorf("with the assigned project disabled a new webinar went to %q, want test", got)
	}
	if res, raw := h.guestJoin(after.ID, "Still on second"); res.StatusCode != http.StatusOK {
		t.Fatalf("join a webinar pinned to the disabled project: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(after.ID); got != "second" {
		t.Errorf("disabling moved a pinned webinar to %q", got)
	}

	// Unknown (removed from the configuration): default order for new rooms.
	if err := h.store.SetUserSFUProject(context.Background(), host, "gone"); err != nil {
		t.Fatal(err)
	}
	last := h.openWebinar("Assigned project gone")
	if res, raw := h.guestJoin(last.ID, "Guest"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(last.ID); got != "test" {
		t.Errorf("with an unknown assignment a new webinar went to %q, want test", got)
	}
}

// A live room is never moved by an assignment either, even one made mid-session.
func TestAnAssignmentNeverMovesALiveRoom(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("second")})
	h.login("neeraj@acme.dev")
	live := h.openWebinar("Live now")
	if res, raw := h.guestJoin(live.ID, "First"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if err := h.store.SetUserSFUProject(context.Background(), hostID(t, h, "neeraj@acme.dev"), "second"); err != nil {
		t.Fatal(err)
	}
	if res, raw := h.guestJoin(live.ID, "Second"); res.StatusCode != http.StatusOK {
		t.Fatalf("join: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(live.ID); got != "test" {
		t.Errorf("a live webinar was moved to %q", got)
	}
}

/* A room on a second SFU publishes its CDN broadcast on THAT box's MediaMTX, so its
 * attendees are sent to that project's own origin; rooms on the default box keep the global
 * one. */
func TestEachProjectsRoomsUseItsOwnBroadcastOrigin(t *testing.T) {
	edge := newFakeProject("edge")
	h := newHarnessWith(t, []*fakeRooms{edge}, func(c *config.Config) {
		c.BroadcastRTMPBase = "rtmp://127.0.0.1:1935/live"
		c.BroadcastHLSBase = "https://live.example.com/live"
		c.LiveKitProjects = append(c.LiveKitProjects,
			config.LiveKitProject{ID: "edge", BroadcastHLSBase: "https://live-edge.example.com/live"})
	})
	h.login("neeraj@acme.dev")
	host := hostID(t, h, "neeraj@acme.dev")
	if _, err := h.store.SetCdnBroadcastCapability(context.Background(), host, true); err != nil {
		t.Fatal(err)
	}
	join := func(slug string) types.JoinResponse {
		t.Helper()
		res, raw := h.guestJoin(slug, "Viewer")
		if res.StatusCode != http.StatusOK {
			t.Fatalf("join %s: %d %s", slug, res.StatusCode, raw)
		}
		var out types.JoinResponse
		h.decode(raw, &out)
		return out
	}

	onDefault := h.openWebinar("Default box")
	if got, want := join(onDefault.ID).CdnStreamURL, "https://live.example.com/live/"+onDefault.ID+"/whep"; got != want {
		t.Errorf("default-box viewer sent to %q, want %q", got, want)
	}

	if err := h.store.SetUserSFUProject(context.Background(), host, "edge"); err != nil {
		t.Fatal(err)
	}
	onEdge := h.openWebinar("Second box")
	j := join(onEdge.ID)
	if got := h.pinOf(onEdge.ID); got != "edge" {
		t.Fatalf("edge-assigned host's webinar pinned to %q", got)
	}
	if got, want := j.CdnStreamURL, "https://live-edge.example.com/live/"+onEdge.ID+"/whep"; got != want {
		t.Errorf("second-box viewer sent to %q, want %q", got, want)
	}
}

func TestAdminVideoServerEndpoints(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("second")}, func(c *config.Config) {
		c.LiveKitProjects = append(c.LiveKitProjects, config.LiveKitProject{
			ID: "second", URL: "wss://second.example.com", Key: "APIsecond", Secret: "very-secret-value",
			Label: "Second server",
		})
	})
	coach := h.signup("SFU Coach", "sfu-coach@test.dev", true)

	// Not an admin: both endpoints refused.
	if res, _ := h.do(http.MethodGet, "/api/admin/sfu-projects", nil); res.StatusCode != http.StatusForbidden {
		t.Errorf("non-admin GET sfu-projects: %d, want 403", res.StatusCode)
	}
	if res, _ := h.do(http.MethodPatch, "/api/admin/users/"+coach.ID+"/sfu", types.SetUserSFURequest{Project: "second"}); res.StatusCode != http.StatusForbidden {
		t.Errorf("non-admin PATCH sfu: %d, want 403", res.StatusCode)
	}

	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/sfu-projects", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET sfu-projects: %d %s", res.StatusCode, raw)
	}
	for _, leak := range []string{"very-secret-value", "APIsecond", "wss://", "secret", "key"} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("sfu-projects response leaks %q: %s", leak, raw)
		}
	}
	var list types.SFUProjectsResponse
	h.decode(raw, &list)
	var second *types.SFUProjectOption
	for i := range list.Projects {
		if list.Projects[i].ID == "second" {
			second = &list.Projects[i]
		}
	}
	if second == nil || second.Label != "Second server" || !second.Enabled {
		t.Fatalf("second project listed as %+v", second)
	}

	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+coach.ID+"/sfu", types.SetUserSFURequest{Project: "nowhere"}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("unknown project: %d %s, want 422", res.StatusCode, raw)
	}
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+coach.ID+"/sfu", types.SetUserSFURequest{Project: "second"}); res.StatusCode != http.StatusOK {
		t.Fatalf("assign: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/admin/users?q=sfu-coach@test.dev", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin users: %d %s", res.StatusCode, raw)
	}
	var users []types.AdminUser
	h.decode(raw, &users)
	if len(users) != 1 || users[0].SFUProject != "second" {
		t.Errorf("admin row = %+v, want sfuProject second", users)
	}
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+coach.ID+"/sfu", types.SetUserSFURequest{Project: ""}); res.StatusCode != http.StatusOK {
		t.Fatalf("clear: %d %s", res.StatusCode, raw)
	}
	if got, _ := h.store.HostSFUProject(t.Context(), coach.ID); got != "" {
		t.Errorf("after clearing, assignment = %q", got)
	}
}
