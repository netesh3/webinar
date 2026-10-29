package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* On GCP and DigitalOcean video servers the admin decides delivery per host (edge.go,
 * hostDelivery; 29 Oct 2026): standard (WebRTC) by default, edge for a host with hls_delivery,
 * whatever the form sent. The boot backfill and an admin's toggle move webinars that have not
 * run yet, both ways. Any other server offers every host the Standard / Edge choice when there
 * is a live origin. Meetings and simulive are never edge. */

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

/* asAdmin runs fn signed in as an admin, then signs back in as email: the hls_delivery switch
 * is only ever an admin's, through the same PATCH the Accounts screen sends. */
func (h *harness) asAdmin(email string, fn func()) {
	h.t.Helper()
	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		h.t.Fatal(err)
	}
	h.logout()
	h.login("neeraj@acme.dev")
	fn()
	h.logout()
	h.login(email)
}

// setHLS turns a host's hls_delivery on or off as an admin would (Admin -> Accounts).
func (h *harness) setHLS(hostID, email string, on bool) {
	h.t.Helper()
	h.asAdmin(email, func() {
		res, raw := h.do(http.MethodPatch, "/api/admin/users/"+hostID+"/features",
			types.FeatureGrant{Feature: types.FeatureHLSDelivery, Enabled: on})
		if res.StatusCode != http.StatusOK {
			h.t.Fatalf("set hls_delivery %v: %d %s", on, res.StatusCode, raw)
		}
	})
}

// createAsking creates a webinar asking for a delivery and returns it as saved.
func (h *harness) createAsking(topic, asked string) types.Webinar {
	h.t.Helper()
	in := edgeInput(topic)
	in.Delivery = asked
	res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
	if res.StatusCode != http.StatusCreated {
		h.t.Fatalf("create asking %q: %d %s", asked, res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if stored := h.delivery(wb.ID); stored != wb.Delivery {
		h.t.Fatalf("response says %q, stored %q", wb.Delivery, stored)
	}
	return wb
}

// A host without hls_delivery: every webinar on DO is standard, whatever the form asks.
func TestWebinarsOnDOAreStandardByDefault(t *testing.T) {
	h := newHarness(t, onDO)
	h.signup("DO Host", "edge-do@test.dev", true)

	if p := h.deliveryPolicy(""); p.EdgeOnly || p.EdgeChoice {
		t.Fatalf("policy = %+v, want no choice and not edge", p)
	}
	for _, asked := range []string{"", types.DeliveryStandard, types.DeliveryEdge} {
		wb := h.createAsking("DO webinar "+asked, asked)
		if wb.Delivery != types.DeliveryStandard {
			t.Fatalf("asked %q: delivery %q, want standard", asked, wb.Delivery)
		}
		// An edit asking for edge keeps it standard: hosts never choose there.
		in := edgeInput("DO webinar " + asked)
		if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in); res.StatusCode != http.StatusOK {
			t.Fatalf("edit: %d %s", res.StatusCode, raw)
		}
		if d := h.delivery(wb.ID); d != types.DeliveryStandard {
			t.Fatalf("after an edit asking edge: %q, want standard", d)
		}
	}

	// The audience joins the room over WebRTC.
	wb := h.liveWebinar("DO live", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })
	if wb.Delivery != types.DeliveryStandard {
		t.Fatalf("live webinar delivery = %q, want standard", wb.Delivery)
	}
	reg := h.registerAsGuest(wb.ID, "edge-do-guest@test.dev")
	res, join, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey)
	if res.StatusCode != http.StatusOK || join.Delivery == types.DeliveryEdge || join.Token == "" || join.PlaybackURL != "" {
		t.Fatalf("join = %d %+v %s, want a LiveKit token", res.StatusCode, join, raw)
	}
}

// A host an admin gave hls_delivery: every webinar on DO is edge, whatever the form asks.
func TestWebinarsOnDOAreEdgeWithHLSDelivery(t *testing.T) {
	h := newHarness(t, onDO)
	acct := h.signup("DO HLS Host", "edge-do-hls@test.dev", true)
	h.setHLS(acct.ID, acct.Email, true)

	if p := h.deliveryPolicy(""); !p.EdgeOnly || p.EdgeChoice {
		t.Fatalf("policy = %+v, want edge only", p)
	}
	for _, asked := range []string{"", types.DeliveryStandard, types.DeliveryEdge} {
		wb := h.createAsking("DO HLS webinar "+asked, asked)
		if wb.Delivery != types.DeliveryEdge {
			t.Fatalf("asked %q: delivery %q, want edge", asked, wb.Delivery)
		}
		in := edgeInput("DO HLS webinar " + asked)
		in.Delivery = types.DeliveryStandard
		if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in); res.StatusCode != http.StatusOK {
			t.Fatalf("edit: %d %s", res.StatusCode, raw)
		}
		if d := h.delivery(wb.ID); d != types.DeliveryEdge {
			t.Fatalf("after an edit asking standard: %q, want edge", d)
		}
	}

	// The audience gets the stream.
	wb := h.liveWebinar("DO HLS live", nil)
	if wb.Delivery != types.DeliveryEdge {
		t.Fatalf("live webinar delivery = %q, want edge", wb.Delivery)
	}
	reg := h.registerAsGuest(wb.ID, "edge-do-hls-guest@test.dev")
	res, join, raw := h.joinAsGuestKey(wb.ID, reg.JoinKey)
	if res.StatusCode != http.StatusOK || join.Delivery != types.DeliveryEdge || join.Token != "" || join.PlaybackURL == "" {
		t.Fatalf("join = %d %+v %s, want an edge viewer", res.StatusCode, join, raw)
	}
}

/* The admin's toggle moves the host's webinars that have not run yet, both ways, series
 * included; live and ended sessions, meetings and other hosts' webinars stay as they are. */
func TestTogglingHLSDeliveryMovesFutureWebinars(t *testing.T) {
	h := newHarness(t, onDO)
	h.signup("Other DO Host", "edge-toggle-other@test.dev", true)
	otherWb := h.newWebinar("Other host's", nil).ID
	h.logout()
	acct := h.signup("Toggle Host", "edge-toggle@test.dev", true)

	scheduled := h.newWebinar("Scheduled", nil).ID
	draft := h.newWebinar("Draft", nil).ID
	h.exec(`UPDATE webinars SET status = 'draft' WHERE slug = $1`, draft)
	ended := h.newWebinar("Ended", nil).ID
	h.exec(`UPDATE webinars SET status = 'ended' WHERE slug = $1`, ended)
	live := h.liveWebinar("Live", nil).ID
	res, raw := h.do(http.MethodPost, "/api/host/webinars", types.WebinarInput{
		Topic: "Standup", Kind: types.KindMeeting, Duration: 30, TimeZone: "UTC",
		StartsAt: time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("meeting: %d %s", res.StatusCode, raw)
	}
	var meeting types.Webinar
	h.decode(raw, &meeting)
	res, raw = h.do(http.MethodPost, "/api/host/webinars", seriesBody("Weekly", seriesStart(t), 3))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("series: %d %s", res.StatusCode, raw)
	}
	var series types.Webinar
	h.decode(raw, &series)
	seriesEdge := func() int {
		var n int
		if err := h.store.Pool().QueryRow(context.Background(),
			`SELECT count(*) FROM webinars WHERE series_id = $1::uuid AND delivery = 'edge'`,
			series.SeriesID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	check := func(when string, want map[string]string, wantSeries int) {
		t.Helper()
		for slug, d := range want {
			if got := h.delivery(slug); got != d {
				t.Errorf("%s: %s delivery %q, want %q", when, slug, got, d)
			}
		}
		if n := seriesEdge(); n != wantSeries {
			t.Errorf("%s: %d of 3 occurrences edge, want %d", when, n, wantSeries)
		}
	}
	std, edge := types.DeliveryStandard, types.DeliveryEdge
	check("before", map[string]string{scheduled: std, draft: std, ended: std, live: std,
		meeting.ID: std, otherWb: std}, 0)

	h.setHLS(acct.ID, acct.Email, true)
	check("on", map[string]string{scheduled: edge, draft: edge, ended: std, live: std,
		meeting.ID: std, otherWb: std}, 3)

	h.setHLS(acct.ID, acct.Email, false)
	// The ended and live ones are made edge by hand: the toggle back must not touch them either.
	h.exec(`UPDATE webinars SET delivery = 'edge' WHERE slug = ANY($1)`, []string{ended, live})
	h.setHLS(acct.ID, acct.Email, false)
	check("off", map[string]string{scheduled: std, draft: std, ended: edge, live: edge,
		meeting.ID: std, otherWb: std}, 0)
}

func TestMeetingsAndSimuliveStayStandardOnDO(t *testing.T) {
	h := newHarness(t, onDO)
	acct := h.signup("DO Coach", "edge-do-coach@test.dev", true)
	// Even for a host on HLS delivery: meetings and simulive are never edge.
	grantFeature(t, h, acct.ID, types.FeatureSimulive, types.FeatureHLSDelivery)

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
 * an admin assigned to it, so every new webinar takes the admin rule: edge here, for a host
 * with hls_delivery. A webinar still pinned to Hetzner that has not run yet is judged by
 * where it will move. */
func TestDeliveryFollowsTheHostsTargetProject(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("india")}, edgeConfig)
	acct := h.signup("Mumbai Host", "edge-india@test.dev", true)
	h.setHLS(acct.ID, acct.Email, true)

	if p := h.deliveryPolicy(""); !p.EdgeOnly || p.EdgeChoice {
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

// A recurring series follows the rule on every occurrence: each is its own row, slug and mix.
func TestRecurringSeriesFollowsTheRule(t *testing.T) {
	check := func(t *testing.T, h *harness, wb types.Webinar, n int) {
		t.Helper()
		var edge int
		if err := h.store.Pool().QueryRow(context.Background(),
			`SELECT count(*) FROM webinars WHERE series_id = $1::uuid AND delivery = 'edge'`,
			wb.SeriesID).Scan(&edge); err != nil {
			t.Fatal(err)
		}
		if edge != n {
			t.Fatalf("%d occurrences edge, want %d", edge, n)
		}
	}

	t.Run("do, hls_delivery", func(t *testing.T) {
		h := newHarness(t, onDO)
		acct := h.signup("Series DO", "edge-series-do@test.dev", true)
		h.setHLS(acct.ID, acct.Email, true)
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

	t.Run("do, default", func(t *testing.T) {
		h := newHarness(t, onDO)
		h.signup("Series DO Std", "edge-series-do-std@test.dev", true)
		in := seriesBody("Daily DO Std", seriesStart(t), 3)
		in.Delivery = types.DeliveryEdge
		res, raw := h.do(http.MethodPost, "/api/host/webinars", in)
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("create series: %d %s", res.StatusCode, raw)
		}
		var wb types.Webinar
		h.decode(raw, &wb)
		check(t, h, wb, 0)
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

/* The boot backfill, both ways: draft and scheduled webinars on (or headed for) a DO server
 * become edge for a host with hls_delivery and standard for everyone else; live and ended
 * sessions, meetings, Zoom and anything pinned to Hetzner are untouched. */
func TestBackfillAppliesTheRuleBothWays(t *testing.T) {
	h := newHarnessWith(t, []*fakeRooms{newFakeProject("hz")}, onDO)

	// A host without the switch whose future webinars were edge (the 24-29 Oct rule).
	h.signup("Was Edge Host", "edge-backfill-std@test.dev", true)
	wasEdge := h.newWebinar("Was edge", nil).ID
	wasEdgeEnded := h.newWebinar("Was edge, ended", nil).ID
	h.exec(`UPDATE webinars SET delivery = 'edge' WHERE slug = ANY($1)`, []string{wasEdge, wasEdgeEnded})
	h.exec(`UPDATE webinars SET status = 'ended' WHERE slug = $1`, wasEdgeEnded)
	h.logout()

	acct := h.signup("Backfill Host", "edge-backfill@test.dev", true)
	// Granted straight in the store, so nothing but the backfill moves its webinars.
	grantFeature(t, h, acct.ID, types.FeatureHLSDelivery)

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
		wasEdge: types.DeliveryStandard, wasEdgeEnded: types.DeliveryEdge,
	}
	for slug, d := range want {
		if got := h.delivery(slug); got != d {
			t.Errorf("%s: delivery %q, want %q", slug, got, d)
		}
	}
}
