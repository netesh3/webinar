package api_test

import (
	"math"
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The admin cost report: usage per host, split by provider, from seeded sessions.
 *
 * Host A runs an Edge webinar on the DigitalOcean box that overlaps host B's Edge webinar
 * there for an hour, and a simulive; B also runs a meeting on Hetzner (the default project)
 * and a standard webinar on GCP. A's August webinar is outside September. */
func TestAdminCostsByHost(t *testing.T) {
	h := newHarness(t)
	a := h.signup("Coach A", "cost-a@test.dev", true)
	b := h.signup("Coach B", "cost-b@test.dev", true)
	ctx := t.Context()
	db := h.store.Pool()

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	// A session from start to end (India time), on a project.
	session := func(slug, host, kind, delivery, project, start, end string) string {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, `
			INSERT INTO webinars (slug, webinar_id, topic, starts_at, duration_min, host_id, kind, status,
			                      delivery, sfu_project, started_at, ended_at)
			VALUES ($1, $1, $1, $5::timestamptz, 60, $2::uuid, $3, 'ended', $4, $6,
			        $5::timestamptz, $7::timestamptz)
			RETURNING id::text`,
			slug, host, kind, delivery, start+"+05:30", project, end+"+05:30").Scan(&id); err != nil {
			t.Fatalf("session %s: %v", slug, err)
		}
		return id
	}
	// A visit of `hours` from the session's start; beat marks an Edge viewer.
	visit := func(webinar, identity, start string, hours float64, beat bool) {
		t.Helper()
		seen := "NULL"
		if beat {
			seen = "$3::timestamptz + make_interval(secs => $4)"
		}
		exec(`INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at, seen_at)
		      VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz + make_interval(secs => $4), `+seen+`)`,
			webinar, identity, start+"+05:30", hours*3600)
	}

	a1 := session("a-edge", a.ID, "live", "edge", "do-blr", "2026-09-10 10:00", "2026-09-10 12:00")
	visit(a1, "host_a", "2026-09-10 10:00", 2, false)
	visit(a1, "att_guest", "2026-09-10 10:00", 1, false) // brought on stage
	for _, v := range []string{"att_1", "att_2", "att_3"} {
		visit(a1, v, "2026-09-10 10:00", 1, true)
	}
	b1 := session("b-edge", b.ID, "live", "edge", "do-blr", "2026-09-10 11:00", "2026-09-10 12:00")
	visit(b1, "host_b", "2026-09-10 11:00", 1, false)
	b2 := session("b-meet", b.ID, "meeting", "standard", "default", "2026-09-12 09:00", "2026-09-12 10:00")
	for _, v := range []string{"host_b", "att_m1", "att_m2", "att_m3"} {
		visit(b2, v, "2026-09-12 09:00", 1, false)
	}
	b3 := session("b-gcp", b.ID, "live", "standard", "india", "2026-09-20 18:00", "2026-09-20 19:00")
	visit(b3, "host_b", "2026-09-20 18:00", 1, false)
	visit(b3, "att_g1", "2026-09-20 18:00", 1, false)
	visit(b3, "att_g2", "2026-09-20 18:00", 1, false)
	a2 := session("a-sim", a.ID, "simulive", "standard", "", "2026-09-15 20:00", "2026-09-15 21:00")
	for i := range 10 {
		visit(a2, "att_s"+string(rune('a'+i)), "2026-09-15 20:00", 0.5, false)
	}
	session("a-aug", a.ID, "live", "standard", "default", "2026-08-20 10:00", "2026-08-20 11:00")

	// Recordings: A's mix recording, B's meeting composite, and a deleted one of A's.
	exec(`INSERT INTO recordings (webinar_id, mime, storage_key, status, size_bytes, duration_ms, egress_id, created_at)
	      VALUES ($1::uuid, 'video/mp4', 'k1', 'ready', 1000000000, 7200000, 'MIXREC_x', '2026-10-01 00:00+05:30')`, a1)
	exec(`INSERT INTO recordings (webinar_id, mime, storage_key, status, size_bytes, duration_ms, egress_id, created_at)
	      VALUES ($1::uuid, 'video/mp4', 'k2', 'ready', 500000000, 3600000, 'EG_abc', '2026-10-01 00:00+05:30')`, b2)
	exec(`INSERT INTO recordings (id, webinar_id, mime, storage_key, status, size_bytes, duration_ms, created_at)
	      VALUES ('00000000-0000-0000-0000-0000000000d1', $1::uuid, 'video/webm', 'k3', 'ready', 2000000000, 0,
	              '2026-09-05 00:00+05:30')`, a1)
	exec(`DELETE FROM recordings WHERE id = '00000000-0000-0000-0000-0000000000d1'`)
	exec(`UPDATE recording_deletions SET deleted_at = '2026-09-15 00:00+05:30'
	       WHERE recording_id = '00000000-0000-0000-0000-0000000000d1'`)

	// AI, exactly as recorded; one call has no host.
	ai := func(host any, feature string, cost float64) {
		exec(`INSERT INTO ai_usage (created_at, feature, host_id, provider, model, prompt_tokens, completion_tokens, cost_usd, ok)
		      VALUES ('2026-09-11 10:00+05:30', $2, $1::uuid, 'openai', 'gpt-5-nano', 1000, 100, $3, true)`, host, feature, cost)
	}
	ai(a.ID, "recap", 0.01)
	ai(a.ID, "recap", 0.01)
	ai(a.ID, "qa_answer", 0.002)
	ai(nil, "sales_chat", 0.5)

	// Mail: two follow-ups and the recap for A; a WhatsApp follow-up.
	for i, ch := range []string{"email", "email", "whatsapp"} {
		exec(`INSERT INTO followup_sends (webinar_id, host_id, lead_key, channel, status, updated_at)
		      VALUES ($1::uuid, $2::uuid, $3, $4, 'sent', '2026-09-11 10:00+05:30')`, a1, a.ID, string(rune('a'+i)), ch)
	}
	exec(`INSERT INTO session_recaps (webinar_id, status, emailed_at) VALUES ($1::uuid, 'ready', '2026-09-10 13:00+05:30')`, a1)

	path := "/api/admin/costs?from=2026-09-01&to=2026-09-30"

	// Only admins.
	h.login("cost-a@test.dev")
	if res, _ := h.do(http.MethodGet, path, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("host: status %d, want 403", res.StatusCode)
	}
	// Anonymous: no cookie jar. (A second harness would truncate the seeded tables.)
	anon, err := http.Get(h.srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	anon.Body.Close()
	if anon.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous: status %d, want 401", anon.StatusCode)
	}
	if _, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")

	get := func(p string, out any) {
		t.Helper()
		res, raw := h.do(http.MethodGet, p, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d body %s", p, res.StatusCode, raw)
		}
		h.decode(raw, out)
	}
	near := func(what string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", what, got, want)
		}
	}
	var rep types.AdminCostsResponse
	get(path, &rep)
	hosts := map[string]types.AdminCostHost{}
	for _, x := range rep.Hosts {
		hosts[x.Email] = x
	}
	ha, hb := hosts["cost-a@test.dev"], hosts["cost-b@test.dev"]

	// Concurrency: A's two hours share one with B's, so 1.5 and 0.5 of the box; the hour
	// two Edge mixes were live needs one extra render, half to each.
	ad, bd := ha.ByProvider["do"], hb.ByProvider["do"]
	near("A box hours", ad.BoxShareHours, 1.5)
	near("B box hours", bd.BoxShareHours, 0.5)
	near("A extra render", ad.EdgeExtraHours, 0.5)
	near("B extra render", bd.EdgeExtraHours, 0.5)
	near("A live hours", ad.LiveHours, 2)
	near("A edge live hours", ad.EdgeLiveHours, 2)
	near("A edge viewer hours", ad.EdgeViewerHours, 3)
	// Two on A's stage (the host and the guest brought up) for two hours: 2·1 pairs.
	near("A stage pair hours", ad.StagePairHours, 4)
	if ad.Attendees != 4 || ad.Webinars != 1 {
		t.Errorf("A on DO = %+v", ad)
	}
	near("A mix recording", ad.MixRecHours, 2)
	near("A recorded GB", ad.RecordedGB, 1)

	// Provider attribution: B's meeting on the default project is Hetzner, India is GCP.
	hm := hb.ByProvider["hetzner"]
	near("B meeting participant hours", hm.MeetingParticipantHours, 4)
	near("B composite recording", hm.CompositeRecHours, 1)
	if hm.Meetings != 1 || hm.StagePairHours != 0 {
		t.Errorf("B on Hetzner = %+v", hm)
	}
	near("B WebRTC viewer hours", hb.ByProvider["gcp"].WebRTCViewerHours, 2)
	near("B GCP box hours", hb.ByProvider["gcp"].BoxShareHours, 1)
	sim := ha.ByProvider["none"]
	near("A simulive viewer hours", sim.SimuliveViewerHours, 5)
	if sim.LiveHours != 0 || sim.Simulives != 1 {
		t.Errorf("simulive = %+v", sim)
	}
	if _, ok := ha.ByProvider["hetzner"]; ok {
		t.Errorf("A's August webinar counted in September: %+v", ha.ByProvider["hetzner"])
	}

	// AI is exact, by feature; the host-less call is the platform's.
	var aiTotal float64
	for _, x := range ha.Extras.AI {
		aiTotal += x.CostUSD
		if x.Feature == "recap" && (x.Calls != 2 || x.PromptTokens != 2000) {
			t.Errorf("recap = %+v", x)
		}
	}
	near("A AI", aiTotal, 0.022)
	near("unattributed AI", rep.Platform.UnattributedAIUSD, 0.5)

	// Storage: the deleted 2 GB recording was held ten days; the kept ones arrived in October.
	near("A recording GB-days", ha.Extras.RecordingGBDays, 20)
	near("A recording GB now", ha.Extras.RecordingGB, 1)
	sends := map[string]int{}
	for _, x := range ha.Extras.Emails {
		sends["email:"+x.Kind] = x.Count
	}
	for _, x := range ha.Extras.WhatsApp {
		sends["wa:"+x.Kind] = x.Count
	}
	if sends["email:followup"] != 2 || sends["email:recap"] != 1 || sends["wa:followup"] != 1 {
		t.Errorf("sends = %v", sends)
	}

	// Platform totals: every host's DO usage, for the pool.
	near("platform DO box hours", rep.Platform.ByProvider["do"].BoxShareHours, 2)
	if rep.Platform.FirstSessionAt["do"] == "" || rep.Platform.FirstSessionAt["hetzner"] == "" {
		t.Errorf("first sessions = %v", rep.Platform.FirstSessionAt)
	}

	// All time takes in August.
	var all types.AdminCostsResponse
	get("/api/admin/costs", &all)
	for _, x := range all.Hosts {
		if x.Email == "cost-a@test.dev" {
			near("A all-time Hetzner hours", x.ByProvider["hetzner"].LiveHours, 1)
		}
	}

	// The provider filter keeps that provider's sessions and drops host-wide costs.
	var gcp types.AdminCostsResponse
	get(path+"&provider=gcp", &gcp)
	if len(gcp.Hosts) != 1 || gcp.Hosts[0].Email != "cost-b@test.dev" || len(gcp.Hosts[0].ByProvider) != 1 {
		t.Errorf("gcp filter = %+v", gcp.Hosts)
	}
	if res, _ := h.do(http.MethodGet, path+"&provider=aws", nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown provider: status %d, want 400", res.StatusCode)
	}
	if res, _ := h.do(http.MethodGet, "/api/admin/costs?from=2026-09-30&to=2026-09-01", nil); res.StatusCode != http.StatusBadRequest {
		t.Errorf("backwards range: status %d, want 400", res.StatusCode)
	}

	// The drill-down: A's sessions, newest first.
	var det types.AdminCostHostDetail
	get("/api/admin/costs/hosts/"+a.ID+"?from=2026-09-01&to=2026-09-30", &det)
	if len(det.Sessions) != 2 || det.Sessions[0].ID != "a-sim" || det.Sessions[1].ID != "a-edge" {
		t.Fatalf("sessions = %+v", det.Sessions)
	}
	if s := det.Sessions[1]; s.Provider != "do" || s.Project != "do-blr" || s.Usage.Attendees != 4 {
		t.Errorf("edge session = %+v", s)
	}
	if det.Sessions[0].Provider != "none" {
		t.Errorf("simulive provider = %q", det.Sessions[0].Provider)
	}
	if res, _ := h.do(http.MethodGet, "/api/admin/costs/hosts/00000000-0000-0000-0000-000000000000", nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown host: status %d, want 404", res.StatusCode)
	}
}
