package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

type liveStatus struct {
	Live []struct {
		Slug      string     `json:"slug"`
		Kind      string     `json:"kind"`
		State     string     `json:"state"`
		Project   string     `json:"project"`
		StartedAt *time.Time `json:"startedAt"`
	} `json:"live"`
	Count     int            `json:"count"`
	ByProject map[string]int `json:"byProject"`
}

func getLiveStatus(t *testing.T, h *harness, secret string) (int, liveStatus) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/internal/live-status", nil)
	if err != nil {
		t.Fatal(err)
	}
	if secret != "" {
		req.Header.Set("X-Tick-Secret", secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out liveStatus
	if res.StatusCode == http.StatusOK {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("decode %s: %v", raw, err)
		}
	}
	return res.StatusCode, out
}

func TestLiveStatusNotMountedWithoutSecret(t *testing.T) {
	h := newHarness(t)
	if code, _ := getLiveStatus(t, h, "anything"); code != http.StatusNotFound {
		t.Errorf("live-status without TICK_SECRET = %d, want 404", code)
	}
}

func TestLiveStatusRefusesWrongSecret(t *testing.T) {
	h := newHarness(t, withTickSecret)
	for _, s := range []string{"", "wrong", testTickSecret + "x"} {
		if code, _ := getLiveStatus(t, h, s); code != http.StatusUnauthorized {
			t.Errorf("live-status with secret %q = %d, want 401", s, code)
		}
	}
}

/* What the deploy guard waits for: live webinars, meetings and simulives, a simulive with its
 * doors open, and a session about to start, each with the video server it is on. Ended, draft
 * and far-off scheduled sessions do not block a deploy. */
func TestLiveStatusListsWhatADeployWouldInterrupt(t *testing.T) {
	h := newHarness(t, withTickSecret)
	h.login("neeraj@acme.dev")
	ctx := context.Background()

	later := func(in *types.WebinarInput) {
		in.StartsAt = time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339)
	}
	set := func(slug, sql string) {
		t.Helper()
		if _, err := h.store.Pool().Exec(ctx, `UPDATE webinars SET `+sql+` WHERE slug = $1`, slug); err != nil {
			t.Fatalf("update %s: %v", slug, err)
		}
	}

	live := h.newWebinar("Live webinar", later)
	h.goLive(live.ID)
	set(live.ID, `sfu_project = 'do-blr'`)

	meeting := h.newWebinar("Live meeting", later)
	set(meeting.ID, `kind = 'meeting'`)
	h.goLive(meeting.ID)

	simLive := h.newWebinar("Playing simulive", later)
	set(simLive.ID, `kind = 'simulive', status = 'live', started_at = now(), sfu_project = 'india'`)

	simDoors := h.newWebinar("Doors-open simulive", later)
	set(simDoors.ID, `kind = 'simulive', simulive_doors_open = true`)

	soon := h.newWebinar("Starting soon", nil) // five minutes out

	ended := h.newWebinar("Ended", later)
	h.goLive(ended.ID)
	if _, err := h.store.SetStatus(ctx, ended.ID, types.StatusEnded); err != nil {
		t.Fatal(err)
	}
	farOff := h.newWebinar("Far off", later)
	staleSoon := h.newWebinar("Never started", later)
	set(staleSoon.ID, `starts_at = now() - interval '2 hours'`)

	code, got := getLiveStatus(t, h, testTickSecret)
	if code != http.StatusOK {
		t.Fatalf("live-status = %d", code)
	}
	byslug := map[string]string{}
	projects := map[string]string{}
	for _, l := range got.Live {
		byslug[l.Slug] = l.Kind + "/" + l.State
		projects[l.Slug] = l.Project
	}
	want := map[string]string{
		live.ID:     "live/live",
		meeting.ID:  "meeting/live",
		simLive.ID:  "simulive/live",
		simDoors.ID: "simulive/doors-open",
		soon.ID:     "live/starting-soon",
	}
	for slug, w := range want {
		if byslug[slug] != w {
			t.Errorf("%s: got %q, want %q (all: %v)", slug, byslug[slug], w, byslug)
		}
	}
	for _, slug := range []string{ended.ID, farOff.ID, staleSoon.ID} {
		if s, ok := byslug[slug]; ok {
			t.Errorf("%s listed as %q; ended, far-off and long-missed sessions must not block", slug, s)
		}
	}
	if got.Count != len(got.Live) || got.Count != len(want) {
		t.Errorf("count = %d with %d listed, want %d", got.Count, len(got.Live), len(want))
	}

	// Pinned sessions report their pin; unpinned ones the default project.
	if projects[live.ID] != "do-blr" || projects[simLive.ID] != "india" {
		t.Errorf("pinned projects: %v", projects)
	}
	def := projects[meeting.ID]
	if def == "" || def == "do-blr" || def == "india" {
		t.Errorf("unpinned meeting on project %q, want the default project", def)
	}
	if got.ByProject["do-blr"] != 1 || got.ByProject["india"] != 1 || got.ByProject[def] != 3 {
		t.Errorf("byProject = %v", got.ByProject)
	}
	for _, l := range got.Live {
		if (l.State == "live") != (l.StartedAt != nil) {
			t.Errorf("%s (%s): startedAt %v", l.Slug, l.State, l.StartedAt)
		}
	}
}
