package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Hetzner is sunset (sfu_retired.go). The harness's default project "test" reads as Hetzner
 * (no provider, an unrecognised name); "do-blr" reads as DigitalOcean. With both configured,
 * nothing new goes to Hetzner, the box's project comes first, and webinars still pinned to
 * Hetzner that have not run yet move to the box, at boot or at their next join. */

// withBox makes do-blr the on-demand box's project (SFU_BOX_PROJECT) and gives it a live origin.
func withBox(c *config.Config) {
	edgeConfig(c)
	c.SFUBox.Project = "do-blr"
}

func (h *harness) hostJoinProject(slug string) string {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/join", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("host join %s: %d %s", slug, res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	return projectOf(h.t, join)
}

func TestNewRoomsNeverGoToHetzner(t *testing.T) {
	india := newFakeProject("india")
	box := newFakeProject("do-blr")
	h := newHarnessWith(t, []*fakeRooms{india, box}, withBox)
	acct := h.signup("Box Host", "retired-new@test.dev", true)

	// No assignment: the box, ahead of the GCP project listed before it. Standard (WebRTC)
	// there without hls_delivery (29 Oct 2026).
	wb := h.newWebinar("New", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })
	if wb.Delivery != types.DeliveryStandard {
		t.Fatalf("new webinar delivery = %q, want standard", wb.Delivery)
	}
	if got := h.hostJoinProject(wb.ID); got != "do-blr" {
		t.Fatalf("new webinar joined %q, want do-blr", got)
	}

	// Assigned to Hetzner by an admin before the sunset: ignored.
	if err := h.store.SetUserSFUProject(context.Background(), acct.ID, "test"); err != nil {
		t.Fatal(err)
	}
	wb2 := h.newWebinar("Assigned to Hetzner", nil)
	if got := h.hostJoinProject(wb2.ID); got != "do-blr" {
		t.Fatalf("host assigned to Hetzner joined %q, want do-blr", got)
	}
	// An explicit assignment to another live server is still honoured.
	if err := h.store.SetUserSFUProject(context.Background(), acct.ID, "india"); err != nil {
		t.Fatal(err)
	}
	wb3 := h.newWebinar("Assigned to GCP", nil)
	if got := h.hostJoinProject(wb3.ID); got != "india" {
		t.Fatalf("host assigned to india joined %q, want india", got)
	}

	// Admin: Hetzner is listed but not offered, and cannot be assigned.
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/sfu-projects", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("sfu projects: %d %s", res.StatusCode, raw)
	}
	var list types.SFUProjectsResponse
	h.decode(raw, &list)
	for _, p := range list.Projects {
		if want := p.ID != "test"; p.Enabled != want {
			t.Errorf("project %s enabled = %v, want %v", p.ID, p.Enabled, want)
		}
	}
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+acct.ID+"/sfu", types.SetUserSFURequest{Project: "test"})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("assign Hetzner: %d %s, want 422", res.StatusCode, raw)
	}
}

func TestAWebinarPinnedToHetznerMovesAtItsNextJoin(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("do-blr")}, withBox)
	// The default "test" project is the harness's own fake (the Hetzner one here).
	hz := h.rooms
	acct := h.signup("Moving Host", "retired-join@test.dev", true)
	// With hls_delivery the box's rule is edge, so the move is seen to set it.
	grantFeature(t, h, acct.ID, types.FeatureHLSDelivery)

	wb := h.newWebinar("Scheduled on Hetzner", nil)
	h.exec(`UPDATE webinars SET sfu_project = 'test', delivery = 'standard' WHERE slug = $1`, wb.ID)

	// Somebody is in its room on Hetzner (a host in the green room): it stays for now.
	hz.setRoster(types.LiveParticipant{Identity: "host_x"})
	if got := h.hostJoinProject(wb.ID); got != "test" {
		t.Fatalf("with people in the Hetzner room, joined %q, want test", got)
	}
	// The room is empty: the next join moves it to the box, and it becomes edge (the rule there).
	hz.setRoster()
	if got := h.hostJoinProject(wb.ID); got != "do-blr" {
		t.Fatalf("joined %q, want do-blr", got)
	}
	if got := h.pinOf(wb.ID); got != "do-blr" {
		t.Fatalf("pin = %q, want do-blr", got)
	}
	if d := h.delivery(wb.ID); d != types.DeliveryEdge {
		t.Fatalf("delivery after the move = %q, want edge", d)
	}

	// A live session on Hetzner is never moved under its audience.
	live := h.liveWebinar("Live on Hetzner", nil)
	h.exec(`UPDATE webinars SET sfu_project = 'test' WHERE slug = $1`, live.ID)
	if got := h.hostJoinProject(live.ID); got != "test" {
		t.Fatalf("live webinar joined %q, want test", got)
	}
}

func TestBootMovesFutureWebinarsOffHetzner(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("do-blr")}, withBox)
	acct := h.signup("Boot Host", "retired-boot@test.dev", true)
	if err := h.store.SetUserSFUProject(context.Background(), acct.ID, "test"); err != nil {
		t.Fatal(err)
	}

	pin := func(topic, status string) string {
		wb := h.newWebinar(topic, nil)
		h.exec(`UPDATE webinars SET sfu_project = 'test', delivery = 'standard', status = $2 WHERE slug = $1`,
			wb.ID, status)
		return wb.ID
	}
	// Without hls_delivery a move to the box makes a webinar standard, even one saved as edge.
	wasEdge := pin("Was edge", "scheduled")
	h.exec(`UPDATE webinars SET delivery = 'edge' WHERE slug = $1`, wasEdge)
	scheduled := pin("Scheduled", "scheduled")
	draft := pin("Draft", "draft")
	ended := pin("Ended", "ended")
	meeting := pin("Meeting", "scheduled")
	h.exec(`UPDATE webinars SET kind = 'meeting' WHERE slug = $1`, meeting)
	live := h.liveWebinar("Live", nil).ID
	h.exec(`UPDATE webinars SET sfu_project = 'test', delivery = 'standard' WHERE slug = $1`, live)

	h.server.MoveOffRetiredServers(context.Background())
	h.server.MoveOffRetiredServers(context.Background()) // idempotent

	want := map[string][2]string{
		wasEdge:   {"do-blr", types.DeliveryStandard},
		scheduled: {"do-blr", types.DeliveryStandard},
		draft:     {"do-blr", types.DeliveryStandard},
		meeting:   {"do-blr", types.DeliveryStandard},
		ended:     {"test", types.DeliveryStandard},
		live:      {"test", types.DeliveryStandard},
	}
	for slug, w := range want {
		if got := h.pinOf(slug); got != w[0] {
			t.Errorf("%s: pin %q, want %q", slug, got, w[0])
		}
		if got := h.delivery(slug); got != w[1] {
			t.Errorf("%s: delivery %q, want %q", slug, got, w[1])
		}
	}
	if got, err := h.store.HostSFUProject(context.Background(), acct.ID); err != nil || got != "" {
		t.Fatalf("host assignment = %q (%v), want cleared", got, err)
	}
}

// With nothing but Hetzner-looking projects there is nowhere to move to: nothing changes.
func TestOnlyHetznerProjectsAreLeftAlone(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("cloud-2")}, edgeConfig)
	h.login("neeraj@acme.dev")
	wb := h.newWebinar("Plain", nil)
	h.exec(`UPDATE webinars SET sfu_project = 'cloud-2' WHERE slug = $1`, wb.ID)
	h.server.MoveOffRetiredServers(context.Background())
	if got := h.hostJoinProject(wb.ID); got != "cloud-2" {
		t.Fatalf("joined %q, want cloud-2", got)
	}
}

/* A disabled project is retired too (2026-10-26): the GCP test server "india" was disabled and
 * its VMs deleted, and a webinar that had not run yet still joined it, because a disabled
 * project keeps answering for what is pinned to it. Now one that has not run moves to the box,
 * at its next join or at boot; one that is live stays where it is. */
func TestWebinarsOnADisabledProjectMoveToTheBox(t *testing.T) {
	india := newFakeProject("india")
	box := newFakeProject("do-blr")
	h := newHarnessWith(t, []*fakeRooms{india, box}, withBox)
	h.signup("Disabled Host", "retired-disabled@test.dev", true)

	pin := func(topic, status string) string {
		wb := h.newWebinar(topic, nil)
		h.exec(`UPDATE webinars SET sfu_project = 'india', status = $2 WHERE slug = $1`, wb.ID, status)
		return wb.ID
	}
	atJoin := pin("Scheduled on india", "scheduled")
	atBoot := pin("Draft on india", "draft")
	live := h.liveWebinar("Live on india", nil).ID
	h.exec(`UPDATE webinars SET sfu_project = 'india' WHERE slug = $1`, live)

	h.pool.enabled["india"] = false

	if got := h.hostJoinProject(atJoin); got != "do-blr" {
		t.Fatalf("scheduled webinar on the disabled project joined %q, want do-blr", got)
	}
	h.server.MoveOffRetiredServers(context.Background())
	if got := h.pinOf(atBoot); got != "do-blr" {
		t.Errorf("draft on the disabled project after boot: pin %q, want do-blr", got)
	}
	if got := h.pinOf(live); got != "india" {
		t.Errorf("live webinar on the disabled project: pin %q, want it left on india", got)
	}
}

/* A project removed from LIVEKIT_PROJECTS altogether, as "default" (Hetzner) is once its
 * entry and the legacy LIVEKIT_* trio go: a webinar pinned to it that has not run repins to
 * the box at its next join (sfu.go repin). */
func TestAWebinarPinnedToARemovedProjectRepinsToTheBox(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("do-blr")}, withBox)
	h.signup("Removed Host", "retired-removed@test.dev", true)
	wb := h.newWebinar("Pinned to a removed server", nil)
	h.exec(`UPDATE webinars SET sfu_project = 'gone-hetzner', status = 'scheduled' WHERE slug = $1`, wb.ID)

	if got := h.hostJoinProject(wb.ID); got != "do-blr" {
		t.Fatalf("joined %q, want do-blr", got)
	}
	if got := h.pinOf(wb.ID); got != "do-blr" {
		t.Fatalf("pin after the join = %q, want do-blr", got)
	}
}
