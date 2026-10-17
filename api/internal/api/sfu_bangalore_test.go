package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The Bangalore migration, end to end (docs/SFU-BANGALORE.md).
 *
 * The harness's own project ("test") plays today's Hetzner box, which production calls
 * "default". The operator adds "blr1" to the front of LIVEKIT_PROJECTS and disables the old
 * one. Nothing pinned may move; everything new must land on Bangalore; and the way back is
 * a reorder.
 */
func TestMovingNewSessionsToBangalore(t *testing.T) {
	blr1 := newFakeProject("blr1")
	h := newHarnessWith(t, []*fakeRooms{blr1})
	h.login("neeraj@acme.dev")

	// Before the switch: "test" is first, so this session is pinned there.
	h.pool.ids = []string{"test", "blr1"}
	before := h.openWebinar("Pinned before the move")
	if res, raw := h.guestJoin(before.ID, "Early"); res.StatusCode != http.StatusOK {
		t.Fatalf("join before the move: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(before.ID); got != "test" {
		t.Fatalf("pin before the move = %q, want test", got)
	}

	// The switch: blr1 first, the old box disabled.
	h.pool.ids = []string{"blr1", "test"}
	h.pool.enabled["test"] = false

	if res, raw := h.guestJoin(before.ID, "Late"); res.StatusCode != http.StatusOK {
		t.Fatalf("join a pinned session after the move: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(before.ID); got != "test" {
		t.Errorf("a session pinned before the move was moved to %q", got)
	}
	after := h.openWebinar("Scheduled after the move")
	if res, raw := h.guestJoin(after.ID, "Newcomer"); res.StatusCode != http.StatusOK {
		t.Fatalf("join a new session: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(after.ID); got != "blr1" {
		t.Errorf("new session pinned to %q, want blr1", got)
	}

	// Rollback: the old box first and enabled again. New sessions go back; blr1's stay.
	h.pool.ids = []string{"test", "blr1"}
	h.pool.enabled["test"] = true
	back := h.openWebinar("After the rollback")
	if res, raw := h.guestJoin(back.ID, "Rolled back"); res.StatusCode != http.StatusOK {
		t.Fatalf("join after rollback: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(back.ID); got != "test" {
		t.Errorf("after rollback a new session landed on %q, want test", got)
	}
	if got := h.pinOf(after.ID); got != "blr1" {
		t.Errorf("rollback moved a blr1 session to %q", got)
	}

	// Decommission: the old box removed. A session scheduled on it is re-pinned on its
	// next join, because nobody can be connected to a session that has not started.
	h.pool.ids = []string{"blr1", "test"}
	h.allowOpenJoin()
	scheduled := h.newWebinar("Scheduled on the old box", func(in *types.WebinarInput) {
		in.Approval = types.ApprovalAutomatic
		in.Passcode = ""
		in.RegistrationRequired = false
	})
	if _, _, err := h.store.ClaimSFUProject(context.Background(), scheduled.ID, "test"); err != nil {
		t.Fatal(err)
	}
	h.pool.forget("test")
	if res, raw := h.guestJoin(scheduled.ID, "Rescued"); res.StatusCode != http.StatusOK {
		t.Fatalf("join a session whose box was removed: %d %s", res.StatusCode, raw)
	}
	if got := h.pinOf(scheduled.ID); got != "blr1" {
		t.Errorf("after removing the old box the scheduled session is on %q, want blr1", got)
	}
}

/* The CDN broadcast is watched from the box the room is on.
 *
 * Egress pushes to the MediaMTX beside each SFU, so a viewer of a blr1 room must be sent
 * to blr1's origin, and a viewer of a room on the old box to the global one. */
func TestTheBroadcastOriginFollowsTheRoomsProject(t *testing.T) {
	blr1 := newFakeProject("blr1")
	h := newHarnessWith(t, []*fakeRooms{blr1}, func(c *config.Config) {
		c.BroadcastRTMPBase = "rtmp://127.0.0.1:1935/live"
		c.BroadcastHLSBase = "https://live.example.com/live"
		c.LiveKitProjects = append(c.LiveKitProjects, config.LiveKitProject{
			ID: "blr1", BroadcastHLSBase: "https://live-in.example.com/live",
		})
	})
	h.login("neeraj@acme.dev")
	host, err := h.store.UserByEmail(context.Background(), "neeraj@acme.dev")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.SetCdnBroadcastCapability(context.Background(), host.ID, true); err != nil {
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

	h.pool.ids = []string{"test", "blr1"}
	old := h.openWebinar("On the old box")
	if got, want := join(old.ID).CdnStreamURL, "https://live.example.com/live/"+old.ID+"/whep"; got != want {
		t.Errorf("old-box viewer sent to %q, want %q", got, want)
	}

	h.pool.ids = []string{"blr1", "test"}
	h.pool.enabled["test"] = false
	next := h.openWebinar("On Bangalore")
	if got, want := join(next.ID).CdnStreamURL, "https://live-in.example.com/live/"+next.ID+"/whep"; got != want {
		t.Errorf("blr1 viewer sent to %q, want %q", got, want)
	}
}
