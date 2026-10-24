package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
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

/* The on-demand video server (sfu_box.go) against a fake DigitalOcean: when it is wanted,
 * the create → ready → destroy flow, the lease that stops two ticks creating two droplets,
 * the drain check, the failure path with its alerts, and what a waiting screen is told. */

const boxProject = "do-blr"
const boxIP = "152.42.156.192"

type boxRig struct {
	h     *harness
	fake  *doapitest.Fake
	ready atomic.Bool // the readiness probe's answer
	// activity is what LiveKit reports; actErr makes it fail.
	mu       sync.Mutex
	activity lk.Activity
	actErr   error
	// skew moves the box's clock forward.
	skew atomic.Int64
	host types.Account
}

func newBoxRig(t *testing.T, tweak ...func(*config.SFUBox)) *boxRig {
	t.Helper()
	rig := &boxRig{}
	h := newHarnessWith(t, []*fakeRooms{newFakeProject(boxProject)}, func(c *config.Config) {
		c.SFUBox = config.SFUBox{
			Project: boxProject, Token: "test", Name: "sfu-blr-1", Region: "blr1", Size: "c-4",
			SnapshotTag: "webinar-sfu-image", Volume: "sfu-data", ReservedIP: boxIP,
			Tags: []string{"webinar-sfu"}, ManagedTag: "webinar-sfu-ondemand",
			Repo: "netesh3/webinar", Ref: "main", WarmLead: 15 * time.Minute, IdleGrace: 40 * time.Minute,
			BootTimeout: 12 * time.Minute, MaxFailures: 2,
		}
		for _, fn := range tweak {
			fn(&c.SFUBox)
		}
	})
	rig.h = h
	rig.fake = doapitest.New("webinar-sfu-image", "sfu-data", "blr1", boxIP)
	t.Cleanup(rig.fake.Close)
	api.SetBox(h.server, rig.fake.Client(),
		func(context.Context) error {
			if rig.ready.Load() {
				return nil
			}
			return errors.New("connection refused")
		},
		func(context.Context) (lk.Activity, error) {
			rig.mu.Lock()
			defer rig.mu.Unlock()
			return rig.activity, rig.actErr
		},
		func() time.Time { return time.Now().Add(time.Duration(rig.skew.Load())) })
	rig.host = h.signup("Box Host", "box-host@test.dev", true)
	if err := h.store.SetUserSFUProject(context.Background(), rig.host.ID, boxProject); err != nil {
		t.Fatal(err)
	}
	return rig
}

func (r *boxRig) step() store.SFUBoxState {
	r.h.t.Helper()
	api.BoxStep(r.h.server, context.Background())
	api.ForgetBoxCache(r.h.server)
	return r.state()
}

func (r *boxRig) state() store.SFUBoxState {
	r.h.t.Helper()
	st, err := r.h.store.SFUBox(context.Background(), boxProject)
	if errors.Is(err, store.ErrNotFound) {
		return store.SFUBoxState{Actual: store.BoxDown, Desired: "down"}
	}
	if err != nil {
		r.h.t.Fatal(err)
	}
	return st
}

func (r *boxRig) setActivity(a lk.Activity, err error) {
	r.mu.Lock()
	r.activity, r.actErr = a, err
	r.mu.Unlock()
}

func (r *boxRig) wantActual(st store.SFUBoxState, want string) {
	r.h.t.Helper()
	if st.Actual != want {
		r.h.t.Fatalf("actual = %s (desired %s, error %q), want %s", st.Actual, st.Desired, st.LastError, want)
	}
}

// bootToReady takes a wanted box from down to ready.
func (r *boxRig) bootToReady() store.SFUBoxState {
	r.h.t.Helper()
	st := r.step()
	r.wantActual(st, store.BoxCreating)
	r.fake.Activate(st.DropletID)
	st = r.step()
	r.wantActual(st, store.BoxBooting)
	r.ready.Store(true)
	st = r.step()
	r.wantActual(st, store.BoxReady)
	return st
}

func TestBoxStaysDownWithNothingScheduled(t *testing.T) {
	r := newBoxRig(t)
	// A session on the default server does not want the box.
	r.h.signup("Other Host", "other-host@test.dev", true)
	r.h.newWebinar("Elsewhere", nil)
	st := r.step()
	r.wantActual(st, store.BoxDown)
	if st.Desired != "down" || r.fake.Creates != 0 {
		t.Fatalf("desired %s, %d creates; want down and none", st.Desired, r.fake.Creates)
	}
}

func TestBoxCreateReadyDestroy(t *testing.T) {
	r := newBoxRig(t)
	r.h.login("box-host@test.dev")
	// Five minutes out: inside the 15-minute warm lead.
	wb := r.h.newWebinar("On the box", nil)

	st := r.step()
	r.wantActual(st, store.BoxCreating)
	if st.Desired != "up" || r.fake.Creates != 1 {
		t.Fatalf("desired %s creates %d", st.Desired, r.fake.Creates)
	}
	c := r.fake.LastCreate
	if c.Image != 2 || c.Size != "c-4" || c.Region != "blr1" || len(c.Volumes) != 1 || c.Volumes[0] != "vol-1" ||
		!strings.Contains(strings.Join(c.Tags, ","), "webinar-sfu-ondemand") || !strings.Contains(strings.Join(c.Tags, ","), "webinar-sfu") ||
		!strings.Contains(c.UserData, "sfu-boot.sh") || !c.Monitoring {
		t.Fatalf("create request = %+v", c)
	}

	// Still "new": nothing more happens, and no second droplet.
	st = r.step()
	r.wantActual(st, store.BoxCreating)
	r.fake.Activate(st.DropletID)
	st = r.step()
	r.wantActual(st, store.BoxBooting)
	if got := r.fake.AssignedTo(boxIP); got != st.DropletID {
		t.Fatalf("reserved IP on %d, want %d", got, st.DropletID)
	}
	// Not answering yet.
	st = r.step()
	r.wantActual(st, store.BoxBooting)
	r.ready.Store(true)
	st = r.step()
	r.wantActual(st, store.BoxReady)
	if r.fake.Creates != 1 || r.fake.Count() != 1 {
		t.Fatalf("creates %d droplets %d, want 1 and 1", r.fake.Creates, r.fake.Count())
	}

	// The session runs and ends; the box stays for the idle grace.
	r.h.goLive(wb.ID)
	st = r.step()
	r.wantActual(st, store.BoxReady)
	if _, err := r.h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	r.skew.Store(int64(30 * time.Minute))
	st = r.step()
	if st.Desired != "up" {
		t.Fatalf("30 min after the end: desired %s, want up (grace)", st.Desired)
	}
	r.wantActual(st, store.BoxReady)

	// Grace over, but somebody is still in a room on LiveKit: that keeps it wanted.
	r.skew.Store(int64(45 * time.Minute))
	r.setActivity(lk.Activity{Rooms: 1, Participants: 1}, nil)
	st = r.step()
	r.wantActual(st, store.BoxReady)
	if r.fake.Deletes != 0 {
		t.Fatal("deleted with a participant in a room")
	}
	// They leave; the grace starts again from the last time they were seen.
	r.setActivity(lk.Activity{}, nil)
	r.skew.Store(int64(90 * time.Minute))
	st = r.step()
	r.wantActual(st, store.BoxDeleting)
	if r.fake.Deletes != 1 {
		t.Fatalf("deletes %d, want 1", r.fake.Deletes)
	}
	st = r.step()
	r.wantActual(st, store.BoxDown)
	if st.DropletID != 0 || r.fake.Count() != 0 || r.fake.AssignedTo(boxIP) != 0 {
		t.Fatalf("after delete: droplet %d, %d droplets, IP on %d", st.DropletID, r.fake.Count(), r.fake.AssignedTo(boxIP))
	}
	hours, _, ok, err := r.h.store.SFUBoxHours(context.Background(), boxProject, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil || !ok || hours <= 0 || hours > 0.1 {
		t.Fatalf("SFUBoxHours = %v %v %v; want a short closed run", hours, ok, err)
	}
}

func TestBoxNeverDestroyedWhileBusy(t *testing.T) {
	r := newBoxRig(t)
	r.h.login("box-host@test.dev")
	wb := r.h.newWebinar("Busy", nil)
	r.bootToReady()
	r.h.goLive(wb.ID)

	// Live, hours later: still up.
	r.skew.Store(int64(5 * time.Hour))
	st := r.step()
	if st.Desired != "up" || r.fake.Deletes != 0 {
		t.Fatalf("live: desired %s deletes %d", st.Desired, r.fake.Deletes)
	}

	// Ended, with its recording still uploading: still up.
	if _, err := r.h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	if _, err := r.h.store.Pool().Exec(context.Background(), `
		INSERT INTO recordings (webinar_id, status, mime, storage_key)
		SELECT id, 'processing', 'video/mp4', 'k' FROM webinars WHERE slug = $1`, wb.ID); err != nil {
		t.Fatal(err)
	}
	st = r.step()
	if st.Desired != "up" || r.fake.Deletes != 0 {
		t.Fatalf("uploading: desired %s deletes %d", st.Desired, r.fake.Deletes)
	}
	if _, err := r.h.store.Pool().Exec(context.Background(), `UPDATE recordings SET status = 'ready'`); err != nil {
		t.Fatal(err)
	}

	// LiveKit cannot say what is running but the box answers its health check: drain, no delete.
	r.skew.Store(int64(6 * time.Hour))
	r.setActivity(lk.Activity{}, errors.New("twirp: timeout"))
	st = r.step()
	r.wantActual(st, store.BoxDraining)
	if r.fake.Deletes != 0 {
		t.Fatal("deleted while LiveKit could not say what is running")
	}
	// An egress still going: drain.
	r.setActivity(lk.Activity{Egresses: 1}, nil)
	st = r.step()
	if r.fake.Deletes != 0 {
		t.Fatalf("deleted with an egress running (state %s)", st.Actual)
	}
	// Nothing at all: deleted.
	r.setActivity(lk.Activity{}, nil)
	r.skew.Store(int64(10 * time.Hour))
	st = r.step()
	r.wantActual(st, store.BoxDeleting)
}

func TestBoxLeaseStopsADoubleCreate(t *testing.T) {
	r := newBoxRig(t)
	r.h.login("box-host@test.dev")
	r.h.newWebinar("Race", nil)

	// Somebody else holds the lease: this step does nothing.
	holder, _, ok, err := r.h.store.TakeSFUBoxLease(context.Background(), boxProject, time.Minute)
	if err != nil || !ok {
		t.Fatalf("take lease: %v %v", ok, err)
	}
	r.step()
	if r.fake.Creates != 0 {
		t.Fatal("created while another step held the lease")
	}
	if err := r.h.store.ReleaseSFUBoxLease(context.Background(), boxProject, holder); err != nil {
		t.Fatal(err)
	}

	// Eight ticks at once: one droplet.
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			api.BoxStep(r.h.server, context.Background())
		}()
	}
	wg.Wait()
	if r.fake.Creates != 1 || r.fake.Count() != 1 {
		t.Fatalf("creates %d droplets %d after concurrent steps, want 1", r.fake.Creates, r.fake.Count())
	}
	// A create whose answer was lost: the next step adopts the droplet rather than make another.
	if _, err := r.h.store.Pool().Exec(context.Background(),
		`UPDATE sfu_box_state SET actual = 'down', droplet_id = NULL`); err != nil {
		t.Fatal(err)
	}
	st := r.step()
	if r.fake.Creates != 1 || st.DropletID == 0 || st.Actual != store.BoxCreating {
		t.Fatalf("after a lost answer: creates %d, state %+v", r.fake.Creates, st)
	}
}

func TestBoxFailureAlertsAndShowsTheHostAnError(t *testing.T) {
	r := newBoxRig(t)
	ctx := context.Background()
	if _, _, err := r.h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	r.h.login("box-host@test.dev")
	wb := r.h.newWebinar("Will fail", nil)
	r.fake.FailCreates = 10

	st := r.step()
	r.wantActual(st, store.BoxDown)
	if st.Failures != 1 || st.NextAttemptAt == nil || !strings.Contains(st.LastError, "create") {
		t.Fatalf("after one failure: %+v", st)
	}
	// Inside the backoff: no new attempt.
	st = r.step()
	if st.Failures != 1 {
		t.Fatalf("retried inside the backoff: %d failures", st.Failures)
	}
	r.skew.Store(int64(time.Minute))
	st = r.step()
	r.wantActual(st, store.BoxFailed)
	if st.Failures != 2 || st.AlertedAt == nil {
		t.Fatalf("after MaxFailures: %+v", st)
	}
	var bells int
	if err := r.h.store.Pool().QueryRow(ctx, `
		SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id
		 WHERE n.kind = 'ops_alert' AND u.is_admin`).Scan(&bells); err != nil || bells != 1 {
		t.Fatalf("admin bell alerts = %d (%v), want 1", bells, err)
	}
	// Still failing later: the alert is not repeated.
	r.skew.Store(int64(10 * time.Minute))
	r.step()
	_ = r.h.store.Pool().QueryRow(ctx, `SELECT count(*) FROM notifications WHERE kind = 'ops_alert'`).Scan(&bells)
	if bells != 1 {
		t.Fatalf("alerts after another failure = %d, want still 1", bells)
	}

	// The host sees an error, not the waiting screen; the status says failed.
	api.ForgetBoxCache(r.h.server)
	r.h.goLive(wb.ID)
	res, raw := r.h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	r.h.wantError(res, raw, http.StatusServiceUnavailable, "sfu_failed")
	var vs types.VideoServerStatus
	res, raw = r.h.do(http.MethodGet, "/api/webinars/"+wb.ID+"/server", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status: %d %s", res.StatusCode, raw)
	}
	r.h.decode(raw, &vs)
	if vs.State != types.VideoServerFailed {
		t.Fatalf("status state %q, want failed", vs.State)
	}
	// Never another provider: the webinar is still pinned to the box's project.
	if p, _ := r.h.store.SFUProjectOf(ctx, wb.ID); p != boxProject && p != "" {
		t.Fatalf("webinar moved to %q", p)
	}

	// DigitalOcean recovers; "Try again" creates at once.
	r.fake.FailCreates = 0
	res, raw = r.h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/server/retry", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("retry: %d %s", res.StatusCode, raw)
	}
	r.h.decode(raw, &vs)
	if vs.State != types.VideoServerStarting || r.fake.Creates != 1 {
		t.Fatalf("after retry: state %q creates %d", vs.State, r.fake.Creates)
	}
}

func TestBoxWaitingScreenAndJoins(t *testing.T) {
	r := newBoxRig(t)
	r.h.login("box-host@test.dev")
	wb := r.h.newWebinar("Wait for it", nil)
	r.h.goLive(wb.ID)

	// Nothing has stepped yet: the host's own join creates the droplet and is told to wait.
	res, raw := r.h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	r.h.wantError(res, raw, http.StatusServiceUnavailable, "sfu_starting")
	if !strings.Contains(string(raw), "Starting servers") {
		t.Errorf("starting message: %s", raw)
	}
	if r.fake.Creates != 1 {
		t.Fatalf("the join did not start the box: %d creates", r.fake.Creates)
	}
	st := r.state()
	if st.RequestedUntil == nil || !st.RequestedUntil.After(time.Now()) {
		t.Fatalf("the join did not ask for the box: %+v", st)
	}
	var vs types.VideoServerStatus
	_, raw = r.h.do(http.MethodGet, "/api/webinars/"+wb.ID+"/server", nil)
	r.h.decode(raw, &vs)
	if vs.State != types.VideoServerStarting || vs.EtaSec <= 0 || !strings.Contains(vs.Message, "about 2 minutes") {
		t.Fatalf("status while creating: %+v", vs)
	}

	// An attendee meanwhile waits too.
	reg := r.h.registerAs(wb.ID, "box-viewer@test.dev")
	res, _, raw = r.h.joinAsGuestKey(wb.ID, reg.JoinKey)
	r.h.wantError(res, raw, http.StatusServiceUnavailable, "sfu_starting")

	// Booting, then the join's own probe sees it answer: in, without waiting for a tick.
	r.fake.Activate(st.DropletID)
	r.step()
	r.ready.Store(true)
	api.ForgetBoxCache(r.h.server)
	res, raw = r.h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host join when up: %d %s", res.StatusCode, raw)
	}
	r.wantActual(r.state(), store.BoxReady)
	res, _, raw = r.h.joinAsGuestKey(wb.ID, reg.JoinKey)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("attendee join when up: %d %s", res.StatusCode, raw)
	}
	api.ForgetBoxCache(r.h.server)
	_, raw = r.h.do(http.MethodGet, "/api/webinars/"+wb.ID+"/server", nil)
	r.h.decode(raw, &vs)
	if vs.State != types.VideoServerReady {
		t.Fatalf("status when up: %+v", vs)
	}
	// The room is on the box's project and nowhere else.
	if p, _ := r.h.store.SFUProjectOf(context.Background(), wb.ID); p != boxProject {
		t.Fatalf("pinned to %q, want %s", p, boxProject)
	}
}

func TestBoxAdminInstantWarmsUpAndLiveStatusShowsIt(t *testing.T) {
	r := newBoxRig(t)
	r.h.login("box-host@test.dev")
	meeting := types.WebinarInput{Topic: "Test now", Kind: types.KindMeeting, Instant: true, TimeZone: "UTC"}
	res, raw := r.h.do(http.MethodPost, "/api/host/webinars", meeting)
	r.h.wantError(res, raw, http.StatusForbidden, "feature_off")
	forceFeature(t, r.h, r.host.ID, types.FeatureInstantWebinar, true)
	res, raw = r.h.do(http.MethodPost, "/api/host/webinars", meeting)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("instant meeting: %d %s", res.StatusCode, raw)
	}
	if r.fake.Creates != 1 {
		t.Fatalf("an instant session on the box did not start it: %d creates", r.fake.Creates)
	}
	r.wantActual(r.state(), store.BoxCreating)
}

func TestBoxLiveStatusReportsTheBox(t *testing.T) {
	secret := "tick-secret-tick-secret-tick-secret-32"
	// live-status is only mounted with a tick secret.
	r2 := newBoxRigWithSecret(t, secret)
	req, _ := http.NewRequest(http.MethodGet, r2.h.srv.URL+"/api/internal/live-status", nil)
	req.Header.Set("X-Tick-Secret", secret)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Boxes map[string]struct {
			Actual  string `json:"actual"`
			Desired string `json:"desired"`
		} `json:"boxes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if b, ok := body.Boxes[boxProject]; !ok || b.Actual != "down" {
		t.Fatalf("boxes = %+v, want %s down", body.Boxes, boxProject)
	}
}

func newBoxRigWithSecret(t *testing.T, secret string) *boxRig {
	t.Helper()
	rig := &boxRig{}
	h := newHarnessWith(t, []*fakeRooms{newFakeProject(boxProject)}, func(c *config.Config) {
		c.TickSecret = secret
		c.SFUBox = config.SFUBox{Project: boxProject, Token: "test", ReservedIP: boxIP, Volume: "sfu-data",
			Region: "blr1", Size: "c-4", SnapshotTag: "webinar-sfu-image", Repo: "netesh3/webinar", Ref: "main"}
	})
	rig.h = h
	return rig
}

func TestBoxAdoptsAnOldDropletAndTimesOutABadBoot(t *testing.T) {
	r := newBoxRig(t)
	r.h.login("box-host@test.dev")
	r.h.newWebinar("Adopt", nil)
	// The droplet that was there before the API managed it, tagged by hand, days old.
	r.fake.Mu.Lock()
	r.fake.Droplets[611424121] = &doapi.Droplet{ID: 611424121, Name: "sfu-blr-1", Status: "active",
		CreatedAt: "2026-10-22T02:30:00Z", Tags: []string{"webinar-sfu", "webinar-sfu-ondemand"}}
	r.fake.Mu.Unlock()

	st := r.step()
	r.wantActual(st, store.BoxBooting)
	if st.DropletID != 611424121 || r.fake.Creates != 0 {
		t.Fatalf("adopt: droplet %d creates %d", st.DropletID, r.fake.Creates)
	}
	// Failing its check, but only just adopted: not failed for being days old.
	st = r.step()
	r.wantActual(st, store.BoxBooting)
	if r.fake.Deletes != 0 {
		t.Fatal("deleted an adopted droplet at once")
	}
	// Somebody is on it: past the boot timeout it is still left alone.
	r.setActivity(lk.Activity{Rooms: 1, Participants: 3}, nil)
	r.skew.Store(int64(13 * time.Minute))
	st = r.step()
	if r.fake.Deletes != 0 || st.AlertedAt == nil {
		t.Fatalf("in use past the boot timeout: deletes %d alerted %v", r.fake.Deletes, st.AlertedAt)
	}
	// Nobody on it: deleted, and counted as a failure.
	r.setActivity(lk.Activity{}, nil)
	st = r.step()
	r.wantActual(st, store.BoxDeleting)
	if st.Failures != 1 || !strings.Contains(st.LastError, "not ready") {
		t.Fatalf("after the timeout: %+v", st)
	}
}

func TestBoxHoursInTheCostReport(t *testing.T) {
	r := newBoxRig(t)
	ctx := context.Background()
	// Three hours inside September, and a run that straddles its end (one hour inside).
	if _, err := r.h.store.Pool().Exec(ctx, `
		INSERT INTO sfu_box_runs (project, droplet_id, created_at, deleted_at) VALUES
		  ($1, 1, '2026-09-10T10:00:00+05:30', '2026-09-10T13:00:00+05:30'),
		  ($1, 2, '2026-09-30T23:00:00+05:30', '2026-10-01T05:00:00+05:30')`, boxProject); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.h.store.PromoteAdmins(ctx, []string{"box-host@test.dev"}); err != nil {
		t.Fatal(err)
	}
	res, raw := r.h.do(http.MethodGet, "/api/admin/costs?from=2026-09-01&to=2026-09-30&fresh=1", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("costs: %d %s", res.StatusCode, raw)
	}
	var rep types.AdminCostsResponse
	r.h.decode(raw, &rep)
	if got := rep.Platform.BoxHours["do"]; got < 3.99 || got > 4.01 {
		t.Fatalf("boxHours[do] = %v, want 4 (measured, not 24/7)", got)
	}
	var box types.AdminSFUBox
	_, raw = r.h.do(http.MethodGet, "/api/admin/sfu-box", nil)
	r.h.decode(raw, &box)
	if !box.Enabled || box.Project != boxProject || len(box.Runs) != 2 {
		t.Fatalf("admin sfu box = %+v", box)
	}
}

/* Clips wait for the box rather than start it: a queued clip asks nothing. An admin's "Make it
 * now" starts it; a clip being made keeps it up; once the queue is made it goes at once,
 * without the idle grace a session leaves. */
func TestBoxClipsWaitThenMakeNow(t *testing.T) {
	r := newBoxRig(t)
	ctx := context.Background()
	r.h.login("box-host@test.dev")
	wb := r.h.newWebinar("Recorded long ago", nil)
	r.h.exec(`UPDATE webinars SET status = 'ended', ended_at = now() - interval '3 days', starts_at = now() - interval '3 days' WHERE slug = $1`, wb.ID)
	rec := r.h.insertTake(wb.ID, "", time.Now().Add(-72*time.Hour), 10*time.Minute, false)
	r.h.exec(`INSERT INTO clip_jobs (recording_id, kind, format, segments, duration_sec, storage_key)
	          VALUES ($1::uuid, 'clip', '9x16', '[]', 30, 'clips/x/' || gen_random_uuid() || '.mp4')`, rec)

	r.wantActual(r.step(), store.BoxDown)
	if r.fake.Creates != 0 {
		t.Fatal("a queued clip started the box")
	}

	if _, _, err := r.h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	r.h.login("neeraj@acme.dev")
	res, raw := r.h.do(http.MethodPost, "/api/admin/clips/make-now", nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), `"queued":1`) {
		t.Fatalf("make now: %d %s", res.StatusCode, raw)
	}
	if r.fake.Creates != 1 {
		t.Fatalf("make now did not start the box: %d creates", r.fake.Creates)
	}
	r.wantActual(r.state(), store.BoxCreating)
	st := r.step()
	r.fake.Activate(st.DropletID)
	r.step()
	r.ready.Store(true)
	r.wantActual(r.step(), store.BoxReady)

	// Being made: kept up, hours on.
	r.h.exec(`UPDATE clip_jobs SET status = 'processing', rush_until = NULL, lease_until = now() + interval '3 minutes'`)
	r.skew.Store(int64(3 * time.Hour))
	if st := r.step(); st.Desired != "up" || r.fake.Deletes != 0 {
		t.Fatalf("while a clip is made: desired %s, deletes %d", st.Desired, r.fake.Deletes)
	}
	// Made: gone at the next step.
	r.h.exec(`UPDATE clip_jobs SET status = 'ready', lease_until = NULL`)
	r.wantActual(r.step(), store.BoxDeleting)
}
