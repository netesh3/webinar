package api_test

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* The host in a simulive's room before it starts, and the live part after its recording
 * (simulive_host.go). */

func (h *harness) simuliveControl(method, slug, action string, body any) (*http.Response, types.Webinar, []byte) {
	h.t.Helper()
	res, raw := h.do(method, "/api/host/webinars/"+slug+"/simulive/"+action, body)
	var wb types.Webinar
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &wb)
	}
	return res, wb, raw
}

func (h *harness) hostJoinSimulive(slug string) types.JoinResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/join", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("host join: %d %s", res.StatusCode, raw)
	}
	var join types.JoinResponse
	h.decode(raw, &join)
	return join
}

func (h *harness) roomMeta(slug string) string {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	return h.rooms.metadata[lk.RoomName(slug)]
}

func (h *harness) setRoster(people ...types.LiveParticipant) {
	h.rooms.mu.Lock()
	h.rooms.roster = people
	h.rooms.mu.Unlock()
}

func TestSimuliveHostEntersWithoutStarting(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Early", "early-coach@test.dev", true)

	// A manual simulive past its time, and an automatic one five minutes out: the host goes
	// in, the page is read, a tick runs — neither starts.
	manual := lazySimulive(t, h, -2*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})
	auto := lazySimulive(t, h, 5*time.Minute, nil)
	for _, sim := range []types.Webinar{manual, auto} {
		join := h.hostJoinSimulive(sim.ID)
		if !join.Simulive || join.CanPublish || join.CanRecord || join.StartedAt != "" {
			t.Fatalf("host join before the start: %+v", join)
		}
		h.server.RunTick(context.Background())
		if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusScheduled {
			t.Fatalf("entering started %s: %s", sim.Topic, wb.Status)
		}
	}

	// Doors at the start, half an hour out: the host is in and may talk to the host team;
	// the audience is told when it opens — until the host opens the doors.
	zero := 0
	shut := lazySimulive(t, h, 30*time.Minute, func(in *types.WebinarInput) { in.Options.SimuliveDoorsOpenMin = &zero })
	h.hostJoinSimulive(shut.ID)
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+shut.ID+"/say",
		types.SendMessageRequest{Kind: types.MsgChat, ID: "host-early-01", Text: "mic check"}); res.StatusCode != http.StatusOK {
		t.Fatalf("host team chat before the doors: %d %s", res.StatusCode, raw)
	}
	guest := h.registerAsGuest(shut.ID, "door-viewer@test.dev")
	res, _, raw := h.joinAsGuestKey(shut.ID, guest.JoinKey)
	h.wantError(res, raw, http.StatusConflict, "too_early")

	res, wb, raw := h.simuliveControl(http.MethodPost, shut.ID, "open-doors", nil)
	if res.StatusCode != http.StatusOK || !wb.SimuliveDoorsOpen || wb.Status != types.StatusScheduled {
		t.Fatalf("open doors: %d %s", res.StatusCode, raw)
	}
	if !strings.Contains(h.roomMeta(shut.ID), `"simuliveDoorsOpen":true`) {
		t.Errorf("the room was not told the doors opened: %s", h.roomMeta(shut.ID))
	}
	if res, _, raw := h.joinAsGuestKey(shut.ID, guest.JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("join once the doors are open: %d %s", res.StatusCode, raw)
	}
	if res, raw := h.sayAsGuest(shut.ID, types.SendMessageRequest{JoinKey: guest.JoinKey, Kind: types.MsgChat, ID: "door-hello-01", Text: "hi"}); res.StatusCode != http.StatusOK {
		t.Fatalf("audience chat once the doors are open: %d %s", res.StatusCode, raw)
	}
	// Again is fine.
	if res, _, raw := h.simuliveControl(http.MethodPost, shut.ID, "open-doors", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("open doors twice: %d %s", res.StatusCode, raw)
	}
}

func TestSimuliveStartInMinutesStartsOnceWhenDue(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Soon", "soon-coach@test.dev", true)
	sim := lazySimulive(t, h, 20*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})
	h.hostJoinSimulive(sim.ID)

	before := time.Now()
	res, wb, raw := h.simuliveControl(http.MethodPut, sim.ID, "start-at", types.SimuliveScheduleRequest{InMin: 2})
	if res.StatusCode != http.StatusOK || wb.Status != types.StatusScheduled {
		t.Fatalf("start in 2: %d %s", res.StatusCode, raw)
	}
	at, err := time.Parse(time.RFC3339, wb.SimuliveStartAt)
	if err != nil || at.Sub(before) < 110*time.Second || at.Sub(before) > 125*time.Second {
		t.Fatalf("pending start %q, want two minutes out", wb.SimuliveStartAt)
	}
	if !strings.Contains(h.roomMeta(sim.ID), `"simuliveStartAt":"`+wb.SimuliveStartAt+`"`) {
		t.Errorf("the room was not told the start: %s", h.roomMeta(sim.ID))
	}
	// The audience reads it too, and the doors came forward with it (10 min before 2 min out).
	if pub := h.publicWebinar(sim.ID); pub.SimuliveStartAt != wb.SimuliveStartAt || pub.Status != types.StatusScheduled {
		t.Fatalf("public view: %+v", pub)
	}
	g := h.registerAsGuest(sim.ID, "soon-viewer@test.dev")
	if res, join, raw := h.joinAsGuestKey(sim.ID, g.JoinKey); res.StatusCode != http.StatusOK || join.SimuliveStartAt != wb.SimuliveStartAt {
		t.Fatalf("guest join with the start two minutes out: %d %s", res.StatusCode, raw)
	}

	// The moment comes: twenty requests and a tick at once start it once, its clock at the
	// pending start — not at starts_at, nor at whichever request came first.
	h.exec(`UPDATE webinars SET simulive_start_at = date_trunc('second', now()) - interval '1 second' WHERE slug = $1`, sim.ID)
	var ensured atomic.Int32
	h.rooms.mu.Lock()
	h.rooms.onEnsureRoom = func() { ensured.Add(1) }
	h.rooms.mu.Unlock()
	var due time.Time
	if err := h.store.Pool().QueryRow(context.Background(), `SELECT simulive_start_at FROM webinars WHERE slug = $1`, sim.ID).Scan(&due); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + sim.ID); err == nil {
				r.Body.Close()
			}
		}()
	}
	h.server.RunTick(context.Background())
	wg.Wait()
	live := h.publicWebinar(sim.ID)
	if live.Status != types.StatusLive || live.SimuliveStartAt != "" {
		t.Fatalf("after the pending start: %+v", live)
	}
	if n := ensured.Load(); n != 1 {
		t.Errorf("started %d times, want once", n)
	}
	if started, _ := time.Parse(time.RFC3339, live.StartedAt); !started.Equal(due) {
		t.Errorf("clock started at %s, want the pending start %s", live.StartedAt, due.Format(time.RFC3339))
	}
	// Once live, the start controls refuse.
	res, _, raw = h.simuliveControl(http.MethodPut, sim.ID, "start-at", types.SimuliveScheduleRequest{InMin: 5})
	h.wantError(res, raw, http.StatusConflict, "started")
}

func TestSimuliveCancelDelayAndValidation(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Delay", "delay-coach@test.dev", true)

	// Manual: start in 5, cancel — waits for the host again.
	manual := lazySimulive(t, h, 10*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})
	h.simuliveControl(http.MethodPut, manual.ID, "start-at", types.SimuliveScheduleRequest{InMin: 5})
	res, wb, raw := h.simuliveControl(http.MethodDelete, manual.ID, "start-at", nil)
	if res.StatusCode != http.StatusOK || wb.SimuliveStartAt != "" {
		t.Fatalf("cancel: %d %s", res.StatusCode, raw)
	}
	if strings.Contains(h.roomMeta(manual.ID), "simuliveStartAt") {
		t.Errorf("the room still has the cancelled start: %s", h.roomMeta(manual.ID))
	}
	// Cancelling nothing is fine.
	if res, _, raw := h.simuliveControl(http.MethodDelete, manual.ID, "start-at", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("cancel twice: %d %s", res.StatusCode, raw)
	}

	// Auto, delayed by five: the pending start is starts_at + 5, and starts_at passing does
	// not start it.
	auto := lazySimulive(t, h, 3*time.Minute, nil)
	startsAt, _ := time.Parse(time.RFC3339, h.publicWebinar(auto.ID).StartsAt)
	res, wb, raw = h.simuliveControl(http.MethodPut, auto.ID, "start-at", types.SimuliveScheduleRequest{DelayMin: 5})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delay: %d %s", res.StatusCode, raw)
	}
	if at, _ := time.Parse(time.RFC3339, wb.SimuliveStartAt); !at.Equal(startsAt.Add(5 * time.Minute)) {
		t.Fatalf("delayed to %s, want %s", wb.SimuliveStartAt, startsAt.Add(5*time.Minute).Format(time.RFC3339))
	}
	// Delay again: after the pending one.
	_, wb, _ = h.simuliveControl(http.MethodPut, auto.ID, "start-at", types.SimuliveScheduleRequest{DelayMin: 5})
	if at, _ := time.Parse(time.RFC3339, wb.SimuliveStartAt); !at.Equal(startsAt.Add(10 * time.Minute)) {
		t.Fatalf("delayed twice to %s", wb.SimuliveStartAt)
	}
	h.exec(`UPDATE webinars SET starts_at = now() - interval '10 seconds' WHERE slug = $1`, auto.ID)
	h.server.RunTick(context.Background())
	if pub := h.publicWebinar(auto.ID); pub.Status != types.StatusScheduled {
		t.Fatalf("a delayed simulive started at its old time: %s", pub.Status)
	}
	// Cancelling now would start it this instant: refused.
	res, _, raw = h.simuliveControl(http.MethodDelete, auto.ID, "start-at", nil)
	h.wantError(res, raw, http.StatusConflict, "would_start")

	// Auto, started early by "Start in 2" ten minutes before its time.
	early := lazySimulive(t, h, 12*time.Minute, nil)
	_, wb, _ = h.simuliveControl(http.MethodPut, early.ID, "start-at", types.SimuliveScheduleRequest{InMin: 2})
	if at, _ := time.Parse(time.RFC3339, wb.SimuliveStartAt); at.After(time.Now().Add(3 * time.Minute)) {
		t.Fatalf("start early: %s", wb.SimuliveStartAt)
	}

	// Validation.
	for name, body := range map[string]types.SimuliveScheduleRequest{
		"nothing":       {},
		"two at once":   {InMin: 2, DelayMin: 5},
		"in the past":   {At: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)},
		"not a time":    {At: "soon"},
		"past the end":  {At: time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)},
		"past a day":    {InMin: types.MaxSimulivePendingStartMin + 1},
		"negative wait": {InMin: -3},
	} {
		res, _, raw := h.simuliveControl(http.MethodPut, manual.ID, "start-at", body)
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s", name, res.StatusCode, raw)
		}
	}
	// Not a simulive.
	plain := h.newWebinar("Plain", nil)
	res, _, raw = h.simuliveControl(http.MethodPost, plain.ID, "start-now", nil)
	h.wantError(res, raw, http.StatusNotFound, "not_simulive")
}

func TestSimuliveStartNowAndEnd(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Now", "now-coach@test.dev", true)
	sim := lazySimulive(t, h, 30*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})
	res, _, raw := h.simuliveControl(http.MethodPost, sim.ID, "end", nil)
	h.wantError(res, raw, http.StatusConflict, "not_live")

	h.simuliveControl(http.MethodPut, sim.ID, "start-at", types.SimuliveScheduleRequest{InMin: 10})
	before := time.Now().Add(-time.Second)
	res, wb, raw := h.simuliveControl(http.MethodPost, sim.ID, "start-now", nil)
	if res.StatusCode != http.StatusOK || wb.Status != types.StatusLive || wb.SimuliveStartAt != "" {
		t.Fatalf("start now: %d %s", res.StatusCode, raw)
	}
	started, _ := time.Parse(time.RFC3339, wb.StartedAt)
	if started.Before(before.Truncate(time.Second)) || started.After(time.Now()) {
		t.Fatalf("the clock started at %s, want now", wb.StartedAt)
	}
	if !strings.Contains(h.roomMeta(sim.ID), `"live"`) {
		t.Errorf("the room was not told: %s", h.roomMeta(sim.ID))
	}
	// Again: the same session, the same clock.
	_, again, _ := h.simuliveControl(http.MethodPost, sim.ID, "start-now", nil)
	if again.StartedAt != wb.StartedAt || again.Status != types.StatusLive {
		t.Fatalf("start now twice: %+v", again)
	}

	res, wb, raw = h.simuliveControl(http.MethodPost, sim.ID, "end", nil)
	if res.StatusCode != http.StatusOK || wb.Status != types.StatusEnded {
		t.Fatalf("end: %d %s", res.StatusCode, raw)
	}
	if res, wb, raw := h.simuliveControl(http.MethodPost, sim.ID, "end", nil); res.StatusCode != http.StatusOK || wb.Status != types.StatusEnded {
		t.Fatalf("end twice: %d %s", res.StatusCode, raw)
	}
	res, _, raw = h.simuliveControl(http.MethodPost, sim.ID, "start-now", nil)
	h.wantError(res, raw, http.StatusConflict, "ended")
}

func TestSimuliveHostControlPermissions(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Coach Owner", "owner-coach@test.dev", true)
	sim := lazySimulive(t, h, 20*time.Minute, func(in *types.WebinarInput) {
		in.Options.SimuliveStart = types.SimuliveStartManual
	})
	co := h.signup("Co Host", "co-sim@test.dev", true)
	panelist := h.signup("Plain Panelist", "panel-sim@test.dev", true)
	h.signup("Other Host", "other-sim@test.dev", true)
	h.login(host.Email)
	for _, email := range []string{co.Email, panelist.Email} {
		if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+sim.ID+"/panelists", types.PanelistRequest{Email: email}); res.StatusCode != http.StatusOK {
			t.Fatalf("add panelist: %d %s", res.StatusCode, raw)
		}
	}
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+sim.ID+"/panelists/"+co.ID+"/co-host", types.CoHostPatch{CoHost: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("co-host: %d %s", res.StatusCode, raw)
	}

	try := func() int {
		res, _, _ := h.simuliveControl(http.MethodPut, sim.ID, "start-at", types.SimuliveScheduleRequest{InMin: 5})
		return res.StatusCode
	}
	h.login("other-sim@test.dev")
	if code := try(); code != http.StatusNotFound {
		t.Errorf("another host: %d", code)
	}
	h.login(panelist.Email)
	if code := try(); code != http.StatusNotFound {
		t.Errorf("a panelist: %d", code)
	}
	h.logout()
	if code := try(); code != http.StatusUnauthorized {
		t.Errorf("signed out (an attendee): %d", code)
	}
	h.login(co.Email)
	if code := try(); code != http.StatusOK {
		t.Errorf("the co-host: %d", code)
	}
	if res, _, raw := h.simuliveControl(http.MethodPost, sim.ID, "start-now", nil); res.StatusCode != http.StatusOK {
		t.Errorf("the co-host starts it: %d %s", res.StatusCode, raw)
	}
}

func TestSimuliveGoesLiveAfterTheRecordingWithTheHost(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Coach Live", "live-coach@test.dev", true)
	sim := lazySimulive(t, h, -90*time.Second, nil)
	guest := h.registerAsGuest(sim.ID, "after-viewer@test.dev")
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusLive {
		t.Fatalf("not started: %s", wb.Status)
	}
	// While it plays: the player is told how long the recording runs, the host has no media.
	_, join, _ := h.joinAsGuestKey(sim.ID, guest.JoinKey)
	if !join.Simulive || !join.CdnBroadcast || join.SimuliveLengthMs < 299990 || join.SimuliveLengthMs > 300010 {
		t.Fatalf("guest join while it plays: %+v", join)
	}

	// Its end comes with the host in the room: live after, not ended.
	h.startedAgo(sim.ID, 6*time.Minute)
	h.setRoster(types.LiveParticipant{Identity: "user_" + host.ID, Role: types.RoleHost})
	wb := h.publicWebinar(sim.ID)
	if wb.Status != types.StatusLive || wb.SimuliveLiveAt == "" {
		t.Fatalf("at the end with the host there: %+v", wb)
	}
	meta := h.roomMeta(sim.ID)
	if !strings.Contains(meta, `"simuliveLiveAt"`) || !strings.Contains(meta, `"simuliveLiveWith":"Coach"`) {
		t.Errorf("the room was not told: %s", meta)
	}
	// And it stays there on the next request and tick.
	h.server.RunTick(context.Background())
	if again := h.publicWebinar(sim.ID); again.Status != types.StatusLive || again.SimuliveLiveAt != wb.SimuliveLiveAt {
		t.Fatalf("after a tick: %+v", again)
	}

	// The host re-joins on an ordinary stage grant, still never recorded.
	hj := h.hostJoinSimulive(sim.ID)
	if hj.Simulive || !hj.SimuliveLive || !hj.CanPublish || hj.CanRecord || hj.CdnBroadcast {
		t.Fatalf("host join in live after: %+v", hj)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+sim.ID+"/recordings", types.StartRecordingRequest{Mime: "video/webm"})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "simulive_not_recordable")

	// The audience gets the ordinary live room: a WebRTC token, no recording to play.
	res, gj, raw := h.joinAsGuestKey(sim.ID, guest.JoinKey)
	if res.StatusCode != http.StatusOK || gj.Simulive || gj.CdnBroadcast || gj.CdnStreamURL != "" || gj.Token == "" || !gj.SimuliveLive {
		t.Fatalf("guest join in live after: %d %s", res.StatusCode, raw)
	}
	// Chat keeps working.
	if res, raw := h.sayAsGuest(sim.ID, types.SendMessageRequest{JoinKey: guest.JoinKey, Kind: types.MsgQuestion, ID: "after-q-0001", Text: "Can you show the pricing?"}); res.StatusCode != http.StatusOK {
		t.Fatalf("question in live after: %d %s", res.StatusCode, raw)
	}

	// The host leaves: it stays live for the grace, then ends.
	h.setRoster()
	h.server.RunTick(context.Background())
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusLive {
		t.Fatalf("ended before the grace: %s", wb.Status)
	}
	var gone *time.Time
	if err := h.store.Pool().QueryRow(context.Background(), `SELECT simulive_host_gone_at FROM webinars WHERE slug = $1`, sim.ID).Scan(&gone); err != nil || gone == nil {
		t.Fatalf("the host leaving was not noted: %v %v", gone, err)
	}
	// Back within the grace: the clock is cleared.
	h.hostJoinSimulive(sim.ID)
	if err := h.store.Pool().QueryRow(context.Background(), `SELECT simulive_host_gone_at FROM webinars WHERE slug = $1`, sim.ID).Scan(&gone); err != nil || gone != nil {
		t.Fatalf("the host's return did not clear the grace: %v %v", gone, err)
	}
	// Gone for good: past the grace it ends, once.
	h.server.RunTick(context.Background())
	h.exec(`UPDATE webinars SET simulive_host_gone_at = now() - interval '3 minutes' WHERE slug = $1`, sim.ID)
	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r, err := (&http.Client{}).Get(h.srv.URL + "/api/webinars/" + sim.ID); err == nil {
				r.Body.Close()
			}
		}()
	}
	wg.Wait()
	if wb := h.publicWebinar(sim.ID); wb.Status != types.StatusEnded {
		t.Fatalf("after the grace: %s", wb.Status)
	}
	h.rooms.mu.Lock()
	deleted := 0
	for _, r := range h.rooms.deleted {
		if r == lk.RoomName(sim.ID) {
			deleted++
		}
	}
	h.rooms.mu.Unlock()
	if deleted != 1 {
		t.Errorf("torn down %d times, want once", deleted)
	}
}

func TestSimuliveEndsAtTheRecordingsEndWithNoHost(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Gone", "gone-coach@test.dev", true)
	sim := lazySimulive(t, h, -90*time.Second, nil)
	h.publicWebinar(sim.ID)
	h.startedAgo(sim.ID, 6*time.Minute)
	wb := h.publicWebinar(sim.ID)
	if wb.Status != types.StatusEnded || wb.SimuliveLiveAt != "" {
		t.Fatalf("at the end with nobody hosting: %+v", wb)
	}
}
