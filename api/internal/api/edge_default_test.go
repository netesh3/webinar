package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Edge is the only webinar delivery on GCP and DigitalOcean video servers (edge.go,
 * resolveDelivery): a webinar there is saved as edge whatever the form sent, and future
 * webinars saved before the rule are moved by the boot backfill. Any other server offers every
 * host the Standard / Edge choice when there is a live origin (no per-account switch). Meetings
 * and simulive are never edge. */

// onDO makes the harness's default project ("test") a DigitalOcean server with an origin.
func onDO(c *config.Config) {
	edgeConfig(c)
	c.LiveKitProjects = []config.LiveKitProject{{ID: "test", Provider: "do"}}
}

func (h *harness) delivery(slug string) string {
	h.t.Helper()
	d, err := h.store.WebinarDelivery(context.Background(), slug)
	if err != nil {
		h.t.Fatalf("delivery of %s: %v", slug, err)
	}
	return d
}

func (h *harness) deliveryPolicy(query string) types.DeliveryPolicy {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/delivery"+query, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("delivery policy: %d %s", res.StatusCode, raw)
	}
	var p types.DeliveryPolicy
	h.decode(raw, &p)
	return p
}

func TestWebinarsOnDOAreAlwaysEdge(t *testing.T) {
	h := newHarness(t, onDO)
	h.signup("DO Host", "edge-do@test.dev", true)

	if p := h.deliveryPolicy(""); !p.EdgeOnly || p.EdgeChoice {
		t.Fatalf("policy = %+v, want edge only", p)
	}

	for _, asked := range []string{"", types.DeliveryStandard, types.DeliveryEdge} {
		in := edgeInput("DO webinar " + asked)
		in.Delivery = asked
		res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create asking %q: %d %s", asked, res.StatusCode, raw)
		}
		var wb types.Webinar
		h.decode(raw, &wb)
		if wb.Delivery != types.DeliveryEdge || h.delivery(wb.ID) != types.DeliveryEdge {
			t.Fatalf("asked %q: delivery %q (stored %q), want edge", asked, wb.Delivery, h.delivery(wb.ID))
		}
		// An edit asking for standard keeps it edge.
		in.Delivery = types.DeliveryStandard
		if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in); res.StatusCode != http.StatusOK {
			t.Fatalf("edit: %d %s", res.StatusCode, raw)
		}
		if d := h.delivery(wb.ID); d != types.DeliveryEdge {
			t.Fatalf("after an edit asking standard: %q, want edge", d)
		}
	}

	// The audience gets the stream.
	wb := h.liveWebinar("DO live", nil)
	if wb.Delivery != types.DeliveryEdge {
		t.Fatalf("live webinar delivery = %q, want edge", wb.Delivery)
	}
	reg := h.registerAsGuest(wb.ID, "edge-do-guest@test.dev")
	res, join, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey)
	if res.StatusCode != http.StatusOK || join.Delivery != types.DeliveryEdge || join.Token != "" || join.PlaybackURL == "" {
		t.Fatalf("join = %d %+v %s, want an edge viewer", res.StatusCode, join, raw)
	}
}

func TestMeetingsAndSimuliveStayStandardOnDO(t *testing.T) {
	h := newHarness(t, onDO)
	acct := h.signup("DO Coach", "edge-do-coach@test.dev", true)
	grantFeature(t, h, acct.ID, types.FeatureSimulive)

	res, raw := h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "Standup", Kind: types.KindMeeting, Duration: 30, TimeZone: "UTC",
		StartsAt: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339), Delivery: types.DeliveryEdge,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("meeting: %d %s", res.StatusCode, raw)
	}
	var meeting types.Webinar
	h.decode(raw, &meeting)
	if d := h.delivery(meeting.ID); d != types.DeliveryStandard {
		t.Fatalf("meeting delivery = %q, want standard", d)
	}

	orig := h.newWebinar("Original", nil)
	rec := h.insertRecording(orig.ID, "ready", 1000)
	res, raw = h.do(http.MethodPost, "/api/host/webinars", simuliveInput(rec))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("simulive: %d %s", res.StatusCode, raw)
	}
	var sim types.Webinar
	h.decode(raw, &sim)
	if d := h.delivery(sim.ID); d != types.DeliveryStandard {
		t.Fatalf("simulive delivery = %q, want standard", d)
	}
}

/* Before the first join there is no pin, so the target is where the room would go. With a
 * GCP or DO server configured that is never the Hetzner one (sfu_retired.go), even for a host
 * an admin assigned to it, so every new webinar is edge. A webinar still pinned to Hetzner
 * that has not run yet is judged by where it will move. */
func TestDeliveryFollowsTheHostsTargetProject(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("india")}, edgeConfig)
	acct := h.signup("Mumbai Host", "edge-india@test.dev", true)

	if p := h.deliveryPolicy(""); !p.EdgeOnly {
		t.Fatalf("new webinar: policy %+v, want edge only (it goes to GCP, not Hetzner)", p)
	}
	if err := h.store.SetUserSFUProject(context.Background(), acct.ID, "test"); err != nil {
		t.Fatal(err)
	}
	if p := h.deliveryPolicy(""); !p.EdgeOnly {
		t.Fatalf("assigned to Hetzner: policy %+v, want edge only", p)
	}
	wb := h.newWebinar("New", func(in *types.WebinarInput) { in.Delivery = types.DeliveryStandard })
	if wb.Delivery != types.DeliveryEdge {
		t.Fatalf("new webinar delivery = %q, want edge", wb.Delivery)
	}
	h.exec(`UPDATE webinars SET sfu_project = 'test', delivery = 'standard' WHERE slug = $1`, wb.ID)
	if p := h.deliveryPolicy("?slug=" + wb.ID); !p.EdgeOnly {
		t.Fatalf("pinned to Hetzner, not run yet: policy %+v, want edge only", p)
	}
}

// Any server that is not GCP or DO offers every host the choice, with no account switch.
func TestOtherServersOfferEveryHostTheChoice(t *testing.T) {
	h := newHarness(t, edgeConfig)
	h.signup("Other Host", "edge-hz@test.dev", true)
	if p := h.deliveryPolicy(""); p.EdgeOnly || !p.EdgeChoice {
		t.Fatalf("policy = %+v, want the choice", p)
	}
	edge := h.newWebinar("Edge by choice", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })
	if edge.Delivery != types.DeliveryEdge {
		t.Fatalf("explicit edge = %q", edge.Delivery)
	}
	std := h.newWebinar("Standard by choice", func(in *types.WebinarInput) { in.Delivery = types.DeliveryStandard })
	if std.Delivery != types.DeliveryStandard {
		t.Fatalf("explicit standard = %q", std.Delivery)
	}
	def := h.newWebinar("Default", nil)
	if def.Delivery != types.DeliveryStandard {
		t.Fatalf("default = %q, want standard", def.Delivery)
	}

	// No live origin: nothing to choose.
	h2 := newHarness(t)
	h2.signup("No Origin Host", "edge-hz-noorigin@test.dev", true)
	if p := h2.deliveryPolicy(""); p.EdgeOnly || p.EdgeChoice {
		t.Fatalf("policy without an origin = %+v, want standard only", p)
	}
}

// Without a live origin nothing is forced: edge there would be a webinar nobody can watch.
func TestDOWithoutAnOriginIsNotForced(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.LiveKitProjects = []config.LiveKitProject{{ID: "test", Provider: "do"}}
	})
	h.signup("No Origin", "edge-noorigin@test.dev", true)
	wb := h.newWebinar("No origin", nil)
	if wb.Delivery != types.DeliveryStandard {
		t.Fatalf("delivery = %q, want standard", wb.Delivery)
	}
}

// A recurring series is edge on every occurrence: each is its own row, slug and mix.
func TestRecurringSeriesIsEdge(t *testing.T) {
	check := func(t *testing.T, h *harness, wb types.Webinar, n int) {
		t.Helper()
		var edge int
		if err := h.store.Pool().QueryRow(context.Background(),
			`SELECT count(*) FROM webinars WHERE series_id = $1::uuid AND delivery = 'edge'`,
			wb.SeriesID).Scan(&edge); err != nil {
			t.Fatal(err)
		}
		if edge != n {
			t.Fatalf("%d of %d occurrences edge, want all", edge, n)
		}
	}

	t.Run("do", func(t *testing.T) {
		h := newHarness(t, onDO)
		h.signup("Series DO", "edge-series-do@test.dev", true)
		in := seriesBody("Daily DO", seriesStart(t), 3)
		in.Delivery = types.DeliveryStandard
		res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create series: %d %s", res.StatusCode, raw)
		}
		var wb types.Webinar
		h.decode(raw, &wb)
		check(t, h, wb, 3)

		// This and following, growing the series: the added occurrences are edge too.
		edit := inputFromWebinar(wb, 5)
		edit.SeriesScope = "following"
		if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, edit); res.StatusCode != http.StatusOK {
			t.Fatalf("grow series: %d %s", res.StatusCode, raw)
		}
		check(t, h, wb, 5)
	})

	t.Run("another server, by choice", func(t *testing.T) {
		h := newHarness(t, edgeConfig)
		edgeHost(t, h, "edge-series-hz@test.dev")
		in := seriesBody("Daily HZ", seriesStart(t), 2)
		in.Delivery = types.DeliveryEdge
		res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create edge series: %d %s", res.StatusCode, raw)
		}
		var wb types.Webinar
		h.decode(raw, &wb)
		check(t, h, wb, 2)
	})
}

/* The boot backfill: draft and scheduled webinars on (or headed for) a DO server become edge;
 * live and ended sessions, meetings, Zoom and anything pinned to Hetzner are untouched. */
func TestBackfillMovesFutureWebinarsOnDOToEdge(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("hz")}, onDO)
	h.signup("Backfill Host", "edge-backfill@test.dev", true)

	mk := func(topic string) string {
		wb := h.newWebinar(topic, nil)
		h.exec(`UPDATE webinars SET delivery = 'standard' WHERE slug = $1`, wb.ID)
		return wb.ID
	}
	scheduled := mk("Scheduled, unpinned")
	draft := mk("Draft")
	h.exec(`UPDATE webinars SET status = 'draft' WHERE slug = $1`, draft)
	pinnedDO := mk("Pinned to DO")
	h.exec(`UPDATE webinars SET sfu_project = 'test' WHERE slug = $1`, pinnedDO)
	pinnedHZ := mk("Pinned to Hetzner")
	h.exec(`UPDATE webinars SET sfu_project = 'hz' WHERE slug = $1`, pinnedHZ)
	ended := mk("Ended")
	h.exec(`UPDATE webinars SET status = 'ended' WHERE slug = $1`, ended)
	zoomed := mk("On Zoom")
	h.exec(`UPDATE webinars SET venue = 'zoom_meeting' WHERE slug = $1`, zoomed)
	live := h.liveWebinar("Live now", nil).ID
	h.exec(`UPDATE webinars SET delivery = 'standard' WHERE slug = $1`, live)
	meeting := mk("Meeting")
	h.exec(`UPDATE webinars SET kind = 'meeting' WHERE slug = $1`, meeting)

	h.server.BackfillEdgeDelivery(context.Background())
	h.server.BackfillEdgeDelivery(context.Background()) // idempotent

	want := map[string]string{
		scheduled: types.DeliveryEdge, draft: types.DeliveryEdge, pinnedDO: types.DeliveryEdge,
		pinnedHZ: types.DeliveryStandard, ended: types.DeliveryStandard, zoomed: types.DeliveryStandard,
		live: types.DeliveryStandard, meeting: types.DeliveryStandard,
	}
	for slug, d := range want {
		if got := h.delivery(slug); got != d {
			t.Errorf("%s: delivery %q, want %q", slug, got, d)
		}
	}
}
