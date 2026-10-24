package api_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/doapi"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The captions box (captions_box.go) against the fake DigitalOcean: made with the video box,
 * deleted with it, never in the video box's way, never left behind, off by default. */

const capTag = "webinar-captions-ondemand"

// RedispatchIdle is the fake LiveKit's: a room with a dispatch gets it re-created.
func (f *fakeRooms) RedispatchIdle(_ context.Context, room, _ string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.dispatches[room]; !ok {
		return false, nil
	}
	f.redispatched = append(f.redispatched, room)
	return true, nil
}

func (f *fakeRooms) redispatches() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.redispatched...)
}

func newCaptionsRig(t *testing.T, on bool) *boxRig {
	t.Helper()
	r := newBoxRigWith(t, func(c *config.Config) {
		c.CaptionsSecret = testCaptionsSecret
		c.LiveKitProjects = []config.LiveKitProject{{ID: boxProject, URL: "wss://lk.test", Key: "APIboxkey", Secret: "boxsecret123"}}
	}, func(b *config.SFUBox) {
		b.Captions = config.CaptionsBox{On: on, Name: "captions-blr-1", Size: "s-2vcpu-4gb",
			SnapshotTag: "webinar-captions-image", Tags: []string{"webinar-captions"},
			Model: "base.en", APIURL: "https://webinarliv.test"}.WithDefaults()
	})
	r.fake.AddImage(doapi.Image{ID: 7, Name: "webinar-captions-image-1", CreatedAt: "2026-10-24T00:00:00Z",
		Regions: []string{"blr1"}, Tags: []string{"webinar-captions-image"}, Status: "available"})
	return r
}

func (r *boxRig) captions() store.CaptionsBoxState {
	r.h.t.Helper()
	cb, err := r.h.store.CaptionsBox(context.Background(), boxProject)
	if err != nil {
		r.h.t.Fatal(err)
	}
	return cb
}

func (r *boxRig) videoDroplets() []int64 { return r.fake.Tagged("webinar-sfu-ondemand") }

func TestCaptionsBoxMadeAndDeletedWithTheVideoBox(t *testing.T) {
	r := newCaptionsRig(t, true)
	r.h.login("box-host@test.dev")
	wb := r.h.newWebinar("Captioned", nil)

	// One step: the video droplet and the captions droplet.
	st := r.step()
	r.wantActual(st, store.BoxCreating)
	cb := r.captions()
	if cb.Actual != store.BoxCreating || cb.DropletID == 0 || len(r.fake.Tagged(capTag)) != 1 || len(r.videoDroplets()) != 1 {
		t.Fatalf("after the first step: captions %+v, captions droplets %v, video droplets %v",
			cb, r.fake.Tagged(capTag), r.videoDroplets())
	}
	if len(r.fake.Created) != 2 {
		t.Fatalf("creates = %d, want 2", len(r.fake.Created))
	}
	video, capCreate := r.fake.Created[0], r.fake.Created[1]
	if strings.Contains(video.UserData, "CAPTIONS") {
		t.Errorf("the video box's user data should say nothing about captions:\n%s", video.UserData)
	}
	tags := strings.Join(capCreate.Tags, ",")
	if capCreate.Size != "s-2vcpu-4gb" || capCreate.Image != 7 || len(capCreate.Volumes) != 0 ||
		!strings.Contains(tags, "webinar-captions") || !strings.Contains(tags, capTag) || strings.Contains(tags, "webinar-sfu") {
		t.Fatalf("captions create = %+v", capCreate)
	}
	for _, want := range []string{"captions-boot.sh", "LIVEKIT_URL=wss://lk.test", "LIVEKIT_API_KEY=APIboxkey",
		"LIVEKIT_API_SECRET=boxsecret123", "CAPTIONS_SECRET=" + testCaptionsSecret, "CAPTIONS_MODEL=base.en",
		"CAPTIONS_CPUS=2", "CAPTIONS_MAX_ROOMS=4", "CAPTIONS_API_URL=https://webinarliv.test", "<<'WEBINARLIV_CAPTIONS'"} {
		if !strings.Contains(capCreate.UserData, want) {
			t.Errorf("captions user data lacks %q", want)
		}
	}
	// No Grafana Cloud settings configured here: none in the user data, so no Alloy on the box.
	if strings.Contains(capCreate.UserData, "GRAFANA") {
		t.Errorf("captions user data has Grafana lines without the settings:\n%s", capCreate.UserData)
	}

	// Active: ready. The video box comes up on its own schedule.
	r.fake.Activate(cb.DropletID)
	r.step()
	if cb = r.captions(); cb.Actual != store.BoxReady {
		t.Fatalf("captions after active: %+v", cb)
	}
	r.fake.Activate(st.DropletID)
	r.step()
	r.ready.Store(true)
	r.wantActual(r.step(), store.BoxReady)

	// A live room whose dispatch went in before the worker was up: re-sent once the box is up,
	// and not again once the agent has said it is live.
	r.h.goLive(wb.ID)
	ctx := context.Background()
	if err := r.h.store.SetServerCaptions(ctx, wb.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.rooms.DispatchAgent(ctx, "webinar_"+wb.ID, "webinar-captions", "{}"); err != nil {
		t.Fatal(err)
	}
	r.step()
	if got := r.rooms.redispatches(); len(got) != 1 || got[0] != "webinar_"+wb.ID {
		t.Fatalf("redispatched %v, want the live room once", got)
	}
	if _, err := r.h.store.SetServerCaptionsLive(ctx, wb.ID, true); err != nil {
		t.Fatal(err)
	}
	r.step()
	if got := r.rooms.redispatches(); len(got) != 1 {
		t.Fatalf("redispatched again after the agent went live: %v", got)
	}

	// The session ends; after the idle grace both go, in the same step.
	if _, err := r.h.store.SetStatus(ctx, wb.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	r.skew.Store(int64(90 * time.Minute))
	st = r.step()
	r.wantActual(st, store.BoxDeleting)
	if cb = r.captions(); cb.Actual != store.BoxDeleting {
		t.Fatalf("captions when the video box is deleted: %+v", cb)
	}
	st = r.step()
	r.wantActual(st, store.BoxDown)
	if cb = r.captions(); cb.Actual != store.BoxDown || cb.DropletID != 0 || r.fake.Count() != 0 {
		t.Fatalf("after: captions %+v, %d droplets", cb, r.fake.Count())
	}
	runs, err := r.h.store.SFUBoxRecentRuns(ctx, store.CaptionsRunProject(boxProject), 5)
	if err != nil || len(runs) != 1 || runs[0].ReadyAt == nil || runs[0].DeletedAt == nil {
		t.Fatalf("captions runs = %+v (%v), want one closed run", runs, err)
	}
}

func TestCaptionsBoxFailureNeverBlocksTheVideoBox(t *testing.T) {
	r := newCaptionsRig(t, true)
	r.h.login("box-host@test.dev")
	r.h.newWebinar("Video first", nil)
	// No captions snapshot: every captions create fails, the video box's does not.
	r.fake.Mu.Lock()
	r.fake.Images = r.fake.Images[:2]
	r.fake.Mu.Unlock()

	st := r.step()
	r.wantActual(st, store.BoxCreating)
	cb := r.captions()
	if cb.Actual != store.BoxDown || cb.Failures != 1 || cb.NextAttemptAt == nil || !strings.Contains(cb.LastError, "snapshot") {
		t.Fatalf("captions after a failed create: %+v", cb)
	}
	r.fake.Activate(st.DropletID)
	r.step()
	r.ready.Store(true)
	r.wantActual(r.step(), store.BoxReady)
	// Retried with backoff; the video box stays ready throughout; MaxFailures (2) emails once.
	r.skew.Store(int64(time.Minute))
	r.wantActual(r.step(), store.BoxReady)
	if cb = r.captions(); cb.Failures != 2 || cb.AlertedAt == nil {
		t.Fatalf("after MaxFailures: %+v", cb)
	}
	if n := len(r.fake.Tagged(capTag)); n != 0 {
		t.Fatalf("%d captions droplets after failed creates", n)
	}

	// The image appears: the next attempt makes it, and an active droplet clears the failures.
	r.fake.AddImage(doapi.Image{ID: 7, Name: "webinar-captions-image-1", CreatedAt: "2026-10-24T00:00:00Z",
		Regions: []string{"blr1"}, Tags: []string{"webinar-captions-image"}, Status: "available"})
	r.skew.Store(int64(5 * time.Minute))
	r.step()
	cb = r.captions()
	if cb.Actual != store.BoxCreating {
		t.Fatalf("after the image appeared: %+v", cb)
	}
	r.fake.Activate(cb.DropletID)
	r.step()
	if cb = r.captions(); cb.Actual != store.BoxReady || cb.Failures != 0 || cb.AlertedAt != nil {
		t.Fatalf("ready: %+v", cb)
	}
}

func TestCaptionsBoxNoOrphanAfterLostCreatesAndBootTimeouts(t *testing.T) {
	r := newCaptionsRig(t, true)
	r.h.login("box-host@test.dev")
	r.h.newWebinar("Lost answers", nil)

	st := r.step()
	first := r.captions().DropletID
	// The row forgets the droplet (a create whose answer was lost): adopted, not duplicated.
	r.h.exec(`UPDATE captions_box_state SET actual = 'down', droplet_id = NULL`)
	r.step()
	if cb := r.captions(); cb.DropletID != first || len(r.fake.Tagged(capTag)) != 1 {
		t.Fatalf("after a lost answer: %+v, captions droplets %v", cb, r.fake.Tagged(capTag))
	}
	// A stray second one (two creates both answered late): deleted on adoption.
	r.fake.Mu.Lock()
	r.fake.Droplets[777] = &doapi.Droplet{ID: 777, Name: "captions-blr-1", Status: "new",
		CreatedAt: time.Now().UTC().Format(time.RFC3339), Tags: []string{"webinar-captions", capTag}}
	r.fake.Mu.Unlock()
	r.h.exec(`UPDATE captions_box_state SET actual = 'down', droplet_id = NULL`)
	r.step()
	if ids := r.fake.Tagged(capTag); len(ids) != 1 {
		t.Fatalf("captions droplets after adopting with a stray = %v, want 1", ids)
	}

	// Never active: past the boot timeout it is deleted and retried, never kept beside a new one.
	// (The video box comes up meanwhile.)
	r.fake.Activate(st.DropletID)
	r.step()
	r.ready.Store(true)
	r.wantActual(r.step(), store.BoxReady)
	r.skew.Store(int64(11 * time.Minute))
	r.step()
	cb := r.captions()
	if cb.Actual != store.BoxDeleting || cb.Failures != 1 || !strings.Contains(cb.LastError, "not active") {
		t.Fatalf("after the boot timeout: %+v", cb)
	}
	r.step() // the tag lists nothing: down
	r.skew.Store(int64(13 * time.Minute))
	r.step() // the retry
	if ids := r.fake.Tagged(capTag); len(ids) != 1 {
		t.Fatalf("captions droplets after a retry = %v, want exactly 1", ids)
	}

	// Switched off mid-run (the API restarts with CAPTIONS_BOX_ENABLED=false): deleted.
	api.SetCaptionsOn(r.h.server, false)
	r.step()
	r.step()
	if ids := r.fake.Tagged(capTag); len(ids) != 0 {
		t.Fatalf("captions droplets after switching off = %v", ids)
	}
	if cb := r.captions(); cb.Actual != store.BoxDown {
		t.Fatalf("captions after switching off: %+v", cb)
	}
}

func TestCaptionsBoxOffByDefault(t *testing.T) {
	r := newCaptionsRig(t, false)
	r.h.login("box-host@test.dev")
	r.h.newWebinar("No captions box", nil)
	st := r.step()
	r.wantActual(st, store.BoxCreating)
	if len(r.fake.Created) != 1 || len(r.fake.Tagged(capTag)) != 0 {
		t.Fatalf("creates %d, captions droplets %v; want only the video box", len(r.fake.Created), r.fake.Tagged(capTag))
	}
	if strings.Contains(r.fake.Created[0].UserData, "CAPTIONS") {
		t.Errorf("the video box's user data should say nothing about captions:\n%s", r.fake.Created[0].UserData)
	}
	if cb := r.captions(); cb.Actual != store.BoxDown || cb.DropletID != 0 {
		t.Fatalf("captions = %+v", cb)
	}
	// A stray captions droplet with the switch off is found and deleted.
	r.fake.Mu.Lock()
	r.fake.Droplets[888] = &doapi.Droplet{ID: 888, Status: "active", Tags: []string{capTag},
		CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	r.fake.Mu.Unlock()
	api.ForgetCaptionsSweep(r.h.server)
	r.step()
	r.step()
	if ids := r.fake.Tagged(capTag); len(ids) != 0 {
		t.Fatalf("stray captions droplet left: %v", ids)
	}
}
