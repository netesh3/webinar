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
	Count      int            `json:"count"`
	ByProject  map[string]int `json:"byProject"`
	Finalizing []struct {
		Slug    string `json:"slug"`
		State   string `json:"state"`
		Project string `json:"project"`
	} `json:"finalizing"`
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

/* Post-session work a box deploy would cut off: a session that ended minutes ago whose recap
 * still waits for the after-session transcript the box is making. Listed under finalizing (for
 * the box's scope), never in live or count, so API and Web deploys are not held by it. */
func TestLiveStatusListsFinalizingSessions(t *testing.T) {
	h := newHarness(t, withTickSecret)
	h.login("neeraj@acme.dev")
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := h.store.Pool().Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	ended := func(topic string) string {
		t.Helper()
		wb := h.newWebinar(topic, nil)
		h.goLive(wb.ID)
		exec(`UPDATE webinars SET sfu_project = 'do-blr' WHERE slug = $1`, wb.ID)
		if _, err := h.store.SetStatus(ctx, wb.ID, types.StatusEnded); err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE webinars SET ended_at = now() - interval '5 minutes' WHERE slug = $1`, wb.ID)
		if _, err := h.store.ScheduleRecap(ctx, wb.ID, 0, 30*time.Minute); err != nil {
			t.Fatal(err)
		}
		return wb.ID
	}

	waiting := ended("Transcript on its way")
	arrived := ended("Transcript arrived")
	if err := h.store.SaveSessionTranscript(ctx, arrived, "large-v3-turbo", nil); err != nil {
		t.Fatal(err)
	}
	old := ended("Ended long ago")
	exec(`UPDATE webinars SET ended_at = now() - interval '40 minutes' WHERE slug = $1`, old)
	done := ended("Recap written")
	exec(`UPDATE session_recaps r SET status = 'skipped' FROM webinars w WHERE w.id = r.webinar_id AND w.slug = $1`, done)
	expired := ended("Wait over")
	exec(`UPDATE session_recaps r SET wait_until = now() - interval '1 minute' FROM webinars w WHERE w.id = r.webinar_id AND w.slug = $1`, expired)

	code, got := getLiveStatus(t, h, testTickSecret)
	if code != http.StatusOK {
		t.Fatalf("live-status = %d", code)
	}
	if len(got.Finalizing) != 1 || got.Finalizing[0].Slug != waiting ||
		got.Finalizing[0].State != "finalizing" || got.Finalizing[0].Project != "do-blr" {
		t.Fatalf("finalizing = %+v, want only %s on do-blr", got.Finalizing, waiting)
	}
	for _, l := range got.Live {
		if l.Slug == waiting {
			t.Errorf("a finalizing session is listed as live: %+v", l)
		}
	}
	if got.Count != len(got.Live) {
		t.Errorf("count = %d with %d live", got.Count, len(got.Live))
	}
}
