package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The 24 Oct 2026 outage: the box was created, its LiveKit could not be reached (the reserved
 * IP was still on the park droplet), the sweeps that ask LiveKit about every live session
 * waited out the whole tick on it, and the box step that would have moved the IP started on
 * an expired context. These pin that down: a LiveKit that hangs must cost the tick nothing
 * while the box is coming up, seconds once it is up, and never a request. */

const parkID = 611853805

// newParkedBoxRig is a box rig with the reserved IP parked on ops-blr-2, as in production.
func newParkedBoxRig(t *testing.T) *boxRig {
	t.Helper()
	r := newBoxRig(t, func(c *config.SFUBox) { c.ParkDroplet = "ops-blr-2" })
	r.fake.Mu.Lock()
	r.fake.Droplets[parkID] = &doapi.Droplet{ID: parkID, Name: "ops-blr-2", Status: "active",
		CreatedAt: time.Now().Add(-30 * 24 * time.Hour).UTC().Format(time.RFC3339)}
	r.fake.ReservedIPs[boxIP] = parkID
	r.fake.Mu.Unlock()
	return r
}

// liveOnBox makes n webinars live on the box, past their start (what the sweeps look at).
func (r *boxRig) liveOnBox(n int) []types.Webinar {
	r.h.t.Helper()
	r.h.login("box-host@test.dev")
	var out []types.Webinar
	for i := 0; i < n; i++ {
		wb := r.h.newWebinar("Live on the box", nil)
		r.h.goLive(wb.ID)
		if _, err := r.h.store.Pool().Exec(context.Background(),
			`UPDATE webinars SET starts_at = now() - interval '10 minutes', sfu_project = $2 WHERE slug = $1`,
			wb.ID, boxProject); err != nil {
			r.h.t.Fatal(err)
		}
		out = append(out, wb)
	}
	return out
}

func (r *boxRig) tick(limit time.Duration) time.Duration {
	r.h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	start := time.Now()
	r.h.server.RunTick(ctx)
	took := time.Since(start)
	if took > limit {
		r.h.t.Fatalf("tick took %s, want under %s", took.Round(time.Millisecond), limit)
	}
	api.ForgetBoxCache(r.h.server)
	return took
}

func TestBoxComesUpInOneTickWhileItsLiveKitHangs(t *testing.T) {
	r := newParkedBoxRig(t)
	r.liveOnBox(3)
	// And one past its maximum duration, which the tick must still end.
	expired := r.liveOnBox(1)[0]
	if _, err := r.h.store.Pool().Exec(context.Background(),
		`UPDATE webinars SET started_at = now() - interval '10 hours', max_duration_min = 60 WHERE slug = $1`,
		expired.ID); err != nil {
		t.Fatal(err)
	}
	r.rooms.hang.Store(true)

	st := r.step()
	r.wantActual(st, store.BoxCreating)
	r.fake.Activate(st.DropletID)

	// Nothing waits on the unreachable LiveKit: the calls are not made while it is creating.
	r.tick(10 * time.Second)
	st = r.state()
	r.wantActual(st, store.BoxBooting)
	if got := r.fake.AssignedTo(boxIP); got != st.DropletID {
		t.Fatalf("reserved IP on %d after one tick, want the box %d", got, st.DropletID)
	}
	// The other sweeps ran: the expired session was ended.
	wb, err := r.h.store.WebinarBySlug(context.Background(), expired.ID)
	if err != nil {
		t.Fatal(err)
	}
	if wb.Status != types.StatusEnded {
		t.Fatalf("expired session is %s, want ended", wb.Status)
	}
}

func TestBoxStepRunsWhenAReadyBoxStopsAnswering(t *testing.T) {
	r := newParkedBoxRig(t)
	r.liveOnBox(3)
	st := r.bootToReady()
	// The IP wandered off (an operator, a park that raced): the next step puts it back.
	r.fake.Mu.Lock()
	r.fake.ReservedIPs[boxIP] = parkID
	r.fake.Mu.Unlock()
	r.rooms.hang.Store(true)

	// Each call to the hung box costs boxCallTimeout, not the tick.
	r.tick(20 * time.Second)
	if got := r.fake.AssignedTo(boxIP); got != st.DropletID {
		t.Fatalf("reserved IP on %d, want the ready box %d", got, st.DropletID)
	}
	r.wantActual(r.state(), store.BoxReady)
}

func TestBoxAssignIsIdempotent(t *testing.T) {
	r := newParkedBoxRig(t)
	r.liveOnBox(1)
	st := r.step()
	r.wantActual(st, store.BoxCreating)
	r.fake.Activate(st.DropletID)
	// An operator moved the IP by hand a moment ago; DigitalOcean's read still says the park
	// droplet, and the assign is refused as already done. Long after the create, too.
	r.fake.Mu.Lock()
	r.fake.ReservedIPs[boxIP] = st.DropletID
	r.fake.StaleIPReads, r.fake.StaleIPDroplet = 1, parkID
	r.fake.Mu.Unlock()
	r.skew.Store(int64(47 * time.Minute))
	st = r.step()
	r.wantActual(st, store.BoxBooting)
	if r.fake.Deletes != 0 {
		t.Fatalf("deleted the box whose IP was already on it (%q)", st.LastError)
	}
}

func TestBoxParksTheIPAfterDelete(t *testing.T) {
	r := newParkedBoxRig(t)
	wb := r.liveOnBox(1)[0]
	r.bootToReady()
	if _, err := r.h.store.SetStatus(context.Background(), wb.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	r.skew.Store(int64(2 * time.Hour))
	r.wantActual(r.step(), store.BoxDeleting)
	r.wantActual(r.step(), store.BoxDown)
	if got := r.fake.AssignedTo(boxIP); got != parkID {
		t.Fatalf("reserved IP on %d after the delete, want parked on %d", got, parkID)
	}
	// Unassigned behind its back (a park that lost a race): the next step parks it again.
	r.fake.Mu.Lock()
	r.fake.ReservedIPs[boxIP] = 0
	r.fake.Mu.Unlock()
	r.wantActual(r.step(), store.BoxDown)
	if got := r.fake.AssignedTo(boxIP); got != parkID {
		t.Fatalf("reserved IP on %d while down, want parked on %d", got, parkID)
	}
}

func TestDeleteLiveWebinarWithAHungVideoServer(t *testing.T) {
	r := newParkedBoxRig(t)
	wbs := r.liveOnBox(2)
	r.bootToReady()
	r.rooms.hang.Store(true)
	start := time.Now()
	res, raw := r.h.do(http.MethodDelete, "/api/host/webinars/"+wbs[0].ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete on a hung box: %d %s", res.StatusCode, raw)
	}
	if took := time.Since(start); took > 10*time.Second {
		t.Fatalf("delete on a hung box took %s", took)
	}

	// The box not reachable at all (being created): no wait.
	r.fake.Mu.Lock()
	r.fake.Droplets = map[int64]*doapi.Droplet{}
	r.fake.Mu.Unlock()
	r.wantActual(r.step(), store.BoxDown)
	start = time.Now()
	res, raw = r.h.do(http.MethodDelete, "/api/host/webinars/"+wbs[1].ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete with the box down: %d %s", res.StatusCode, raw)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("delete with the box down took %s", took)
	}
}

func TestDeleteLiveWebinarOnAHungDefaultServer(t *testing.T) {
	h := newHarness(t)
	h.signup("Hung Host", "hung-host@test.dev", true)
	wb := h.newWebinar("Hung", nil)
	h.goLive(wb.ID)
	h.rooms.hang.Store(true)
	start := time.Now()
	res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete on a hung server: %d %s", res.StatusCode, raw)
	}
	if took := time.Since(start); took > 10*time.Second {
		t.Fatalf("delete on a hung server took %s", took)
	}
}
