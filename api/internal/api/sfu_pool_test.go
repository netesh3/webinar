package api_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/doapi/doapitest"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The pool of video servers (sfu_pool.go) against a fake DigitalOcean: sessions packed onto a
 * box that is up, spilled onto the next slot when it is full, placed by region (with the
 * fallback), placed ahead of their start, a full region going to the least loaded box with an
 * admin alert, and the join following the placement. Every webinar costs the same here
 * (pointsFlat), so the arithmetic is the test's, not the plan's. */

const (
	poolBLR2 = "do-blr-2"
	poolUS   = "do-us"
	poolIP2  = "10.0.0.2"
	poolIPUS = "10.0.0.3"
)

// pointsFlat makes every webinar 31 points whatever its seats (30 + one point per million seats).
var pointsFlat = config.BoxPoints{Mix: 30, Extra: 0, ViewersPerPoint: 1_000_000, MeetingBase: 4,
	MeetingBaseSize: 10, MeetingPeoplePerPoint: 2}

type poolRig struct {
	h     *harness
	fake  *doapitest.Fake
	rooms map[string]*fakeRooms
	ready map[string]*atomic.Bool
	host  types.Account
}

// poolSlot is a slot like the primary, as config.parseBoxSlots would build it.
func poolSlot(p config.SFUBox, project, name, area, region, volume, ip string) config.SFUBox {
	s := p
	s.Slots, s.Points = nil, config.BoxPoints{}
	s.Project, s.Name, s.Area, s.Region, s.Volume, s.ReservedIP = project, name, area, region, volume, ip
	s.ManagedTag = p.ManagedTag + "-" + name
	s.Captions.Name, s.Captions.ManagedTag = "captions-"+name, p.Captions.ManagedTag+"-"+name
	return s
}

// newPoolRig is a pool of three boxes (two in "in", one in "us") of capacity points each;
// slots false is the primary alone, as today.
func newPoolRig(t *testing.T, capacity int, slots bool) *poolRig {
	t.Helper()
	rig := &poolRig{rooms: map[string]*fakeRooms{}, ready: map[string]*atomic.Bool{}}
	projects := []string{boxProject}
	if slots {
		projects = append(projects, poolBLR2, poolUS)
	}
	var extra []*fakeRooms
	for _, p := range projects {
		rig.rooms[p] = newFakeProject(p)
		rig.ready[p] = &atomic.Bool{}
		extra = append(extra, rig.rooms[p])
	}
	h := newHarnessWith(t, extra, func(c *config.Config) {
		c.EmptyRoomCloseMin = 30
		c.SFUBox = config.SFUBox{
			Project: boxProject, Token: "test", Name: "sfu-blr-1", Region: "blr1", Size: "c-4",
			SnapshotTag: "webinar-sfu-image", Volume: "sfu-data", ReservedIP: boxIP,
			Tags: []string{"webinar-sfu"}, ManagedTag: "webinar-sfu-ondemand",
			Repo: "netesh3/webinar", Ref: "main", WarmLead: 15 * time.Minute, IdleGrace: 40 * time.Minute,
			BootTimeout: 12 * time.Minute, MaxFailures: 2, Area: "in", Capacity: capacity, Points: pointsFlat,
		}
		if slots {
			c.SFUBox.Slots = []config.SFUBox{
				poolSlot(c.SFUBox, poolBLR2, "sfu-blr-2", "in", "blr1", "sfu-data-2", poolIP2),
				poolSlot(c.SFUBox, poolUS, "sfu-nyc-1", "us", "nyc3", "sfu-data-us", poolIPUS),
			}
		}
	})
	rig.h = h
	rig.fake = doapitest.New("webinar-sfu-image", "sfu-data", "blr1", boxIP)
	t.Cleanup(rig.fake.Close)
	rig.fake.AddVolume("sfu-data-2", "blr1")
	rig.fake.AddReservedIP(poolIP2)
	rig.fake.AddVolume("sfu-data-us", "nyc3")
	rig.fake.AddReservedIP(poolIPUS)
	rig.fake.AddImage(doapi.Image{ID: 3, Name: "webinar-sfu-image-nyc", CreatedAt: "2026-10-21T00:00:00Z",
		Regions: []string{"nyc3"}, Tags: []string{"webinar-sfu-image"}, Status: "available"})
	for _, p := range projects {
		ready := rig.ready[p]
		api.SetPoolBox(h.server, p, rig.fake.Client(),
			func(context.Context) error {
				if ready.Load() {
					return nil
				}
				return errors.New("connection refused")
			},
			func(context.Context) (lk.Activity, error) { return lk.Activity{}, nil },
			time.Now)
	}
	rig.host = h.signup("Pool Host", "pool-host@test.dev", true)
	if err := h.store.SetUserSFUProject(context.Background(), rig.host.ID, boxProject); err != nil {
		t.Fatal(err)
	}
	h.login("pool-host@test.dev")
	return rig
}

func (r *poolRig) sweep() { api.SweepBoxes(r.h.server, context.Background()) }

func (r *poolRig) pinned(slug string) string {
	r.h.t.Helper()
	var p string
	if err := r.h.store.Pool().QueryRow(context.Background(),
		`SELECT coalesce(sfu_project, '') FROM webinars WHERE slug = $1`, slug).Scan(&p); err != nil {
		r.h.t.Fatal(err)
	}
	return p
}

func (r *poolRig) state(project string) store.SFUBoxState {
	r.h.t.Helper()
	st, err := r.h.store.SFUBox(context.Background(), project)
	if errors.Is(err, store.ErrNotFound) {
		return store.SFUBoxState{Actual: store.BoxDown, Desired: "down"}
	}
	if err != nil {
		r.h.t.Fatal(err)
	}
	return st
}

// creates is the droplets created with tag, by name.
func (r *poolRig) createdNames() []string {
	r.fake.Mu.Lock()
	defer r.fake.Mu.Unlock()
	var out []string
	for _, c := range r.fake.Created {
		out = append(out, c.Name)
	}
	return out
}

func (r *poolRig) wantPinned(slug, want string) {
	r.h.t.Helper()
	if got := r.pinned(slug); got != want {
		r.h.t.Fatalf("%s is on %q, want %q", slug, got, want)
	}
}

// the session's region, written as the schedule form would have.
func (r *poolRig) setRegion(slug, region string) {
	r.h.t.Helper()
	r.h.exec(`UPDATE webinars SET sfu_region = $2 WHERE slug = $1`, slug, region)
}

func TestPoolPointsOfWebinarsAndMeetings(t *testing.T) {
	p := config.DefaultBoxPoints()
	for _, c := range []struct {
		name string
		got  int
		want int
	}{
		{"webinar of 50 seats", p.Webinar(50), 35},
		{"webinar of 300 seats", p.Webinar(300), 60},
		{"webinar of 1 seat", p.Webinar(1), 31},
		{"meeting of 10", p.Meeting(10), 4},
		{"meeting of 11", p.Meeting(11), 5},
		{"meeting of 50", p.Meeting(50), 24},
	} {
		if c.got != c.want {
			t.Errorf("%s = %d points, want %d", c.name, c.got, c.want)
		}
	}

	// On a server: a webinar by its seats, a meeting by the host's meeting size.
	r := newPoolRig(t, 100, true)
	wb := r.h.newWebinar("Seats", func(in *types.WebinarInput) { in.AttendeeLimit = 50 })
	if got := api.PoolPoints(r.h.server, context.Background(), wb); got != pointsFlat.Webinar(50) {
		t.Fatalf("webinar points = %d, want %d", got, pointsFlat.Webinar(50))
	}
	wb.Kind = types.KindMeeting
	if got := api.PoolPoints(r.h.server, context.Background(), wb); got != pointsFlat.Meeting(10) {
		t.Fatalf("meeting points = %d, want %d (a plan's meeting of 10)", got, pointsFlat.Meeting(10))
	}
	wb.Kind = types.KindSimulive
	if got := api.PoolPoints(r.h.server, context.Background(), wb); got != 0 {
		t.Fatalf("simulive points = %d, want 0 (its audience plays the file)", got)
	}
}

func TestPoolPacksOntoTheRunningBoxThenSpillsToTheNextSlot(t *testing.T) {
	// 70 points: two 31-point webinars fit on a box, a third does not.
	r := newPoolRig(t, 70, true)
	a := r.h.newWebinar("First", nil)
	r.sweep()
	r.wantPinned(a.ID, boxProject)
	if st := r.state(boxProject); st.Actual != store.BoxCreating {
		t.Fatalf("primary %s, want creating", st.Actual)
	}
	if st := r.state(poolBLR2); st.Actual != store.BoxDown || st.Desired != "down" {
		t.Fatalf("second box %s/%s, want down: nothing is on it", st.Actual, st.Desired)
	}

	b := r.h.newWebinar("Second", nil)
	r.sweep()
	r.wantPinned(b.ID, boxProject) // the running box still has room (62 of 70)

	c := r.h.newWebinar("Third", nil)
	r.sweep()
	r.wantPinned(c.ID, poolBLR2)
	st := r.state(poolBLR2)
	if st.Actual != store.BoxCreating || st.Desired != "up" {
		t.Fatalf("second box %s/%s, want creating/up for the third session", st.Actual, st.Desired)
	}
	names := r.createdNames()
	if strings.Join(names, ",") != "sfu-blr-1,sfu-blr-2" {
		t.Fatalf("droplets created %v, want the primary then the second slot", names)
	}
	// The second slot's droplet is its own: its volume, its managed tag, not the primary's.
	r.fake.Mu.Lock()
	last := r.fake.LastCreate
	r.fake.Mu.Unlock()
	tags := strings.Join(last.Tags, ",")
	if len(last.Volumes) != 1 || last.Volumes[0] != "vol-2" ||
		!strings.Contains(tags, "webinar-sfu-ondemand-sfu-blr-2") || strings.Contains(tags, "webinar-sfu-ondemand,") {
		t.Fatalf("second slot create = volumes %v tags %v", last.Volumes, last.Tags)
	}
	if r.state(poolUS).Actual != store.BoxDown {
		t.Fatal("the US box came up for sessions in India")
	}
}

func TestPoolPlacesBySessionRegionWithAFallback(t *testing.T) {
	r := newPoolRig(t, 100, true)

	// The form's region: the US box. A region the pool does not serve is refused.
	res, raw := r.h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "From New York", "startsAt": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 60, "timeZone": "America/New_York", "kind": "live", "status": "scheduled",
		"registrationRequired": true, "approval": "automatic", "attendeeLimit": 50, "sfuRegion": "US",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d %s", res.StatusCode, raw)
	}
	var us types.Webinar
	r.h.decode(raw, &us)
	if us.SFURegion != "us" {
		t.Fatalf("region = %q, want us", us.SFURegion)
	}
	res, raw = r.h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "From Mars", "startsAt": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 60, "timeZone": "UTC", "kind": "live", "status": "scheduled",
		"registrationRequired": true, "approval": "automatic", "attendeeLimit": 50, "sfuRegion": "mars",
	})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "sfuRegion") {
		t.Fatalf("unknown region = %d %s, want 422 on sfuRegion", res.StatusCode, raw)
	}

	// Into the warm lead: placed on the US box, which alone comes up.
	r.h.exec(`UPDATE webinars SET starts_at = now() + interval '5 minutes' WHERE slug = $1`, us.ID)
	r.sweep()
	r.wantPinned(us.ID, poolUS)
	if r.state(poolUS).Actual != store.BoxCreating || r.state(boxProject).Actual != store.BoxDown {
		t.Fatalf("US %s, primary %s; want the US box creating and the primary down",
			r.state(poolUS).Actual, r.state(boxProject).Actual)
	}
	r.fake.Mu.Lock()
	last := r.fake.LastCreate
	r.fake.Mu.Unlock()
	if last.Region != "nyc3" || last.Image != 3 || last.Name != "sfu-nyc-1" {
		t.Fatalf("US create = region %s image %d name %s", last.Region, last.Image, last.Name)
	}

	// A region with no box (set behind the API's back) goes to the default region's box.
	other := r.h.newWebinar("Nowhere", nil)
	r.setRegion(other.ID, "eu")
	r.sweep()
	r.wantPinned(other.ID, boxProject)

	// The region list the form offers: the default first.
	res, raw = r.h.do(http.MethodGet, "/api/config", nil)
	var cfg types.AppConfig
	r.h.decode(raw, &cfg)
	if res.StatusCode != http.StatusOK || strings.Join(cfg.BoxRegions, ",") != "in,us" {
		t.Fatalf("config regions = %v (%d), want [in us]", cfg.BoxRegions, res.StatusCode)
	}
}

func TestPoolFullRegionGoesToTheLeastLoadedBoxAndTellsTheAdmins(t *testing.T) {
	// 40 points: one webinar per box. Two boxes in "in", three webinars.
	r := newPoolRig(t, 40, true)
	r.h.exec(`UPDATE users SET is_admin = true WHERE email = $1`, "pool-host@test.dev")
	a := r.h.newWebinar("One", nil)
	r.sweep()
	b := r.h.newWebinar("Two", nil)
	r.sweep()
	r.wantPinned(a.ID, boxProject)
	r.wantPinned(b.ID, poolBLR2)

	c := r.h.newWebinar("Three", nil)
	r.sweep()
	// Neither box has room: the least loaded (equal, so the first) takes it. Never the US box.
	r.wantPinned(c.ID, boxProject)
	var bells int
	if err := r.h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id
		 WHERE n.kind = 'ops_alert' AND u.is_admin AND n.subject LIKE '%video server in in is full%'`).Scan(&bells); err != nil || bells != 1 {
		t.Fatalf("admin full alerts = %d (%v), want 1", bells, err)
	}
	// A fourth: still placed, the alert not repeated.
	d := r.h.newWebinar("Four", nil)
	r.sweep()
	if got := r.pinned(d.ID); got != boxProject && got != poolBLR2 {
		t.Fatalf("fourth on %q, want a box in India", got)
	}
	_ = r.h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM notifications WHERE kind = 'ops_alert' AND subject LIKE '%is full%'`).Scan(&bells)
	if bells != 1 {
		t.Fatalf("full alerts after a fourth = %d, want still 1", bells)
	}
}

func TestPoolGoLiveAndJoinUseThePlacedBox(t *testing.T) {
	// 40 points: the second webinar to go live lands on the second box, and its host's token,
	// its room and the waiting screen are all that box's.
	r := newPoolRig(t, 40, true)
	r.ready[boxProject].Store(true)
	r.ready[poolBLR2].Store(true)
	first := r.h.newWebinar("Already on", nil)
	r.sweep()
	r.wantPinned(first.ID, boxProject)

	// Two hours out: outside the warm lead, so nothing places it until it starts.
	later := r.h.newWebinar("Starting now", nil)
	r.h.exec(`UPDATE webinars SET starts_at = now() + interval '2 hours' WHERE slug = $1`, later.ID)
	r.sweep()
	if got := r.pinned(later.ID); got != "" {
		t.Fatalf("placed %q two hours ahead, want unplaced", got)
	}
	r.h.goLive(later.ID)
	r.h.exec(`UPDATE webinars SET starts_at = now() WHERE slug = $1`, later.ID)
	// The host's join places it (firstChoice) and asks for its box.
	res, raw := r.h.do(http.MethodPost, "/api/host/webinars/"+later.ID+"/join", nil)
	r.wantPinned(later.ID, poolBLR2)
	// Bring the second box up (its step runs in the sweep; the probe answers).
	for range 4 {
		r.sweep()
		if st := r.state(poolBLR2); st.DropletID != 0 {
			r.fake.Activate(st.DropletID)
		}
	}
	if st := r.state(poolBLR2); st.Actual != store.BoxReady {
		t.Fatalf("second box %s (%s), want ready; first join = %d %s", st.Actual, st.LastError, res.StatusCode, raw)
	}
	res, raw = r.h.do(http.MethodPost, "/api/host/webinars/"+later.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host join = %d %s", res.StatusCode, raw)
	}
	var tok types.JoinResponse
	r.h.decode(raw, &tok)
	if !strings.Contains(tok.URL, poolBLR2) {
		t.Fatalf("token URL %q, want the second box's LiveKit", tok.URL)
	}
	_, raw = r.h.do(http.MethodGet, "/api/webinars/"+later.ID+"/server", nil)
	var vs types.VideoServerStatus
	r.h.decode(raw, &vs)
	if vs.State != types.VideoServerReady {
		t.Fatalf("waiting screen = %+v, want ready (the second box)", vs)
	}

	// The admin's view: both boxes, each with its session and points.
	r.h.exec(`UPDATE users SET is_admin = true WHERE email = $1`, "pool-host@test.dev")
	_, raw = r.h.do(http.MethodGet, "/api/admin/sfu-pool", nil)
	var pool types.AdminSFUPool
	r.h.decode(raw, &pool)
	if !pool.Enabled || len(pool.Boxes) != 3 {
		t.Fatalf("pool = %+v", pool)
	}
	for _, b := range pool.Boxes {
		want := map[string]string{boxProject: first.ID, poolBLR2: later.ID}[b.Project]
		if want == "" {
			continue
		}
		if len(b.Sessions) != 1 || b.Sessions[0].Slug != want || b.Used != 31 || b.Capacity != 40 {
			t.Fatalf("box %s = %+v, want %s at 31/40", b.Project, b, want)
		}
	}
}

func TestPoolOfOneIsTheBoxAsBefore(t *testing.T) {
	// No slots, a tiny capacity: nothing is placed ahead, nothing alerts, every session is
	// the one box's, exactly as before the pool.
	r := newPoolRig(t, 1, false)
	r.h.exec(`UPDATE users SET is_admin = true WHERE email = $1`, "pool-host@test.dev")
	a := r.h.newWebinar("One", nil)
	b := r.h.newWebinar("Two", nil)
	r.sweep()
	if r.pinned(a.ID) != "" || r.pinned(b.ID) != "" {
		t.Fatalf("a pool of one pinned ahead: %q %q", r.pinned(a.ID), r.pinned(b.ID))
	}
	if st := r.state(boxProject); st.Desired != "up" || st.Actual != store.BoxCreating {
		t.Fatalf("box %s/%s, want up/creating for the unpinned sessions", st.Desired, st.Actual)
	}
	var bells int
	_ = r.h.store.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM notifications WHERE kind = 'ops_alert'`).Scan(&bells)
	if bells != 0 {
		t.Fatalf("alerts = %d, want none", bells)
	}
	res, raw := r.h.do(http.MethodGet, "/api/config", nil)
	var cfg types.AppConfig
	r.h.decode(raw, &cfg)
	if res.StatusCode != http.StatusOK || len(cfg.BoxRegions) != 1 {
		t.Fatalf("regions = %v, want one (so the form offers no choice)", cfg.BoxRegions)
	}
}
