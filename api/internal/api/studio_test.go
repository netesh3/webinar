package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The Studio (studio.go): the host's recordings and clips across their own sessions, and the
 * clip plan, all behind the clips switch; another host's sessions never show, and their
 * clips cannot be planned. */

func (f highlightFixture) studioRecordings(query string) types.StudioRecordingsResponse {
	f.h.t.Helper()
	res, raw := f.h.do(http.MethodGet, "/api/host/studio/recordings"+query, nil)
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("studio recordings: %d %s", res.StatusCode, raw)
	}
	var out types.StudioRecordingsResponse
	f.h.decode(raw, &out)
	return out
}

func (f highlightFixture) studioClips(query string) types.StudioClipsResponse {
	f.h.t.Helper()
	res, raw := f.h.do(http.MethodGet, "/api/host/studio/clips"+query, nil)
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("studio clips: %d %s", res.StatusCode, raw)
	}
	var out types.StudioClipsResponse
	f.h.decode(raw, &out)
	return out
}

// makeClip queues a 30-second clip in two formats and returns their ids.
func (f highlightFixture) makeClip(title string) []string {
	f.h.t.Helper()
	res, raw := f.h.do(http.MethodPost, f.path+"/clips", types.CreateClipsRequest{
		Kind: types.ClipKindClip, Title: title, Ranges: []types.ClipRange{{StartSec: 120, EndSec: 150}},
		Formats: []string{types.ClipFormatVertical, types.ClipFormatSquare}, Captions: true,
	})
	if res.StatusCode != http.StatusCreated {
		f.h.t.Fatalf("create clip: %d %s", res.StatusCode, raw)
	}
	var out types.ClipsResponse
	f.h.decode(raw, &out)
	var ids []string
	for _, c := range out.Clips {
		if c.Title == title {
			ids = append(ids, c.ID)
		}
	}
	return ids
}

func TestStudioIsBehindTheClipsSwitch(t *testing.T) {
	f := clipSession(t)
	ids := f.makeClip("Pay yourself first")
	forceFeature(t, f.h, f.host.ID, types.FeatureClips, false)
	for _, path := range []string{"/api/host/studio/recordings", "/api/host/studio/clips"} {
		res, raw := f.h.do(http.MethodGet, path, nil)
		if res.StatusCode != http.StatusForbidden || !strings.Contains(string(raw), "feature_off") {
			t.Fatalf("%s with the switch off: %d %s", path, res.StatusCode, raw)
		}
	}
	res, raw := f.h.do(http.MethodPatch, f.path+"/clips/"+ids[0]+"/plan", types.ClipPlanInput{Status: types.ClipPlanIdea})
	if res.StatusCode != http.StatusForbidden || !strings.Contains(string(raw), "feature_off") {
		t.Fatalf("plan with the switch off: %d %s", res.StatusCode, raw)
	}
}

func TestStudioRecordingsSayWhereEachStands(t *testing.T) {
	f := clipSession(t)

	got := f.studioRecordings("")
	if len(got.Recordings) != 1 || got.NextCursor != "" {
		t.Fatalf("recordings = %+v", got)
	}
	r := got.Recordings[0]
	// Two takes of 10 and 5 minutes, the first one's file for the thumbnail, nothing asked yet:
	// listing never runs the AI.
	if r.ID != f.rec || r.Slug != f.wb.ID || r.Topic != "Money basics" || r.Takes != 2 ||
		r.DurationMs != (15*time.Minute).Milliseconds() || r.ThumbPartID != f.rec ||
		r.HighlightsStatus != types.StudioNotStarted || r.ReelsStatus != types.StudioNotStarted ||
		r.ClipsReady+r.ClipsPending+r.ClipsFailed != 0 {
		t.Fatalf("recording = %+v", r)
	}
	if n := f.model.callsFor("highlights"); n != 0 {
		t.Fatalf("listing asked the AI %d times", n)
	}

	// "Find highlights" is the recording's own POST; the list reads what it stored.
	if res, raw := f.h.do(http.MethodPost, f.path+"/highlights", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("find highlights: %d %s", res.StatusCode, raw)
	}
	ids := f.makeClip("Pay yourself first")
	f.h.exec(`UPDATE clip_jobs SET status = 'failed', error = 'No.' WHERE id = $1::uuid`, ids[1])
	r = f.studioRecordings("").Recordings[0]
	if r.HighlightsStatus != types.AIStatusReady || r.Highlights == 0 || r.ClipsPending != 1 || r.ClipsFailed != 1 {
		t.Fatalf("after highlights and a clip = %+v", r)
	}

	// Searched by the session's title.
	if n := len(f.studioRecordings("?q=money").Recordings); n != 1 {
		t.Fatalf("q=money: %d", n)
	}
	if n := len(f.studioRecordings("?q=" + "100%25").Recordings); n != 0 {
		t.Fatalf("q=100%%: %d", n)
	}
	res, raw := f.h.do(http.MethodGet, "/api/host/studio/recordings?cursor=nonsense", nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad cursor: %d %s", res.StatusCode, raw)
	}
}

func TestStudioPagesNewestFirst(t *testing.T) {
	f := clipSession(t)
	// Two more ended sessions with a recording each, older than the fixture's.
	var slugs []string
	for i, topic := range []string{"Older one", "Oldest one"} {
		wb := f.h.liveWebinar(topic, nil)
		f.h.endSession(wb.ID)
		f.h.insertTake(wb.ID, "", f.starts.Add(-time.Duration(i+1)*24*time.Hour), time.Minute, false)
		slugs = append(slugs, wb.ID)
	}
	first := f.studioRecordings("?limit=2")
	if len(first.Recordings) != 2 || first.NextCursor == "" || first.Recordings[0].ID != f.rec ||
		first.Recordings[1].Slug != slugs[0] {
		t.Fatalf("page 1 = %+v", first)
	}
	second := f.studioRecordings("?limit=2&cursor=" + first.NextCursor)
	if len(second.Recordings) != 1 || second.NextCursor != "" || second.Recordings[0].Slug != slugs[1] {
		t.Fatalf("page 2 = %+v", second)
	}
}

func TestStudioClipPlan(t *testing.T) {
	f := clipSession(t)
	ids := f.makeClip("Pay yourself first")
	plan := func(id string, in types.ClipPlanInput) (int, string) {
		res, raw := f.h.do(http.MethodPatch, f.path+"/clips/"+id+"/plan", in)
		return res.StatusCode, string(raw)
	}

	// Waiting to be made: nothing to plan yet.
	if code, raw := plan(ids[0], types.ClipPlanInput{Status: types.ClipPlanIdea}); code != http.StatusConflict {
		t.Fatalf("plan a queued clip: %d %s", code, raw)
	}
	f.h.exec(`UPDATE clip_jobs SET status = 'ready', size_bytes = 1000 WHERE id = $1::uuid`, ids[0])

	for name, in := range map[string]types.ClipPlanInput{
		"unknown platform":    {Platforms: []string{"myspace"}},
		"not a date":          {PlannedOn: "next tuesday"},
		"not a real day":      {PlannedOn: "2026-02-30"},
		"unknown status":      {Status: "sent"},
		"scheduled, no day":   {Status: types.ClipPlanScheduled},
		"a note far too long": {Note: strings.Repeat("x", types.ClipPlanNoteMaxRunes+1)},
	} {
		if code, raw := plan(ids[0], in); code != http.StatusBadRequest || !strings.Contains(raw, "bad_plan") {
			t.Errorf("%s: %d %s", name, code, raw)
		}
	}

	code, raw := plan(ids[0], types.ClipPlanInput{
		Platforms: []string{types.ClipPlatformLinkedIn, types.ClipPlatformReels, types.ClipPlatformLinkedIn},
		PlannedOn: "2026-11-03", Status: types.ClipPlanScheduled, Note: "  After the newsletter  ",
	})
	if code != http.StatusOK {
		t.Fatalf("plan: %d %s", code, raw)
	}
	var saved types.ClipPlan
	f.h.decode([]byte(raw), &saved)
	if strings.Join(saved.Platforms, ",") != "instagram_reels,linkedin" || saved.PlannedOn != "2026-11-03" ||
		saved.Status != types.ClipPlanScheduled || saved.Note != "After the newsletter" {
		t.Fatalf("saved = %+v", saved)
	}

	// The Studio's list carries it, and the session; filtered to ready, only that one.
	all := f.studioClips("")
	if len(all.Clips) != 2 {
		t.Fatalf("clips = %+v", all)
	}
	ready := f.studioClips("?status=ready")
	if len(ready.Clips) != 1 || ready.Clips[0].Clip.ID != ids[0] || ready.Clips[0].Plan == nil ||
		ready.Clips[0].Plan.PlannedOn != "2026-11-03" || ready.Clips[0].Slug != f.wb.ID ||
		ready.Clips[0].RecordingID != f.rec || ready.Clips[0].Topic != "Money basics" {
		t.Fatalf("ready = %+v", ready)
	}
	pending := f.studioClips("?status=pending")
	if len(pending.Clips) != 1 || pending.Clips[0].Plan != nil || pending.Server.Text == "" {
		t.Fatalf("pending = %+v", pending)
	}
	if res, raw := f.h.do(http.MethodGet, "/api/host/studio/clips?status=everything", nil); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad status: %d %s", res.StatusCode, raw)
	}

	// Posted, with the day cleared: unplanned but done.
	if code, raw := plan(ids[0], types.ClipPlanInput{Status: types.ClipPlanPosted}); code != http.StatusOK {
		t.Fatalf("posted: %d %s", code, raw)
	}
	p := f.studioClips("?status=ready").Clips[0].Plan
	if p == nil || p.Status != types.ClipPlanPosted || p.PlannedOn != "" || len(p.Platforms) != 0 {
		t.Fatalf("after posted = %+v", p)
	}

	// Deleting the clip takes its plan with it.
	if res, raw := f.h.do(http.MethodDelete, f.path+"/clips/"+ids[0], nil); res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d %s", res.StatusCode, raw)
	}
	var left int
	if err := f.h.store.Pool().QueryRow(f.ctx, `SELECT count(*) FROM clip_plans WHERE clip_id = $1::uuid`, ids[0]).Scan(&left); err != nil || left != 0 {
		t.Fatalf("plan left behind: %d %v", left, err)
	}
}

func TestStudioIsTheCallersOwnSessionsOnly(t *testing.T) {
	f := clipSession(t)
	ids := f.makeClip("Pay yourself first")
	f.h.exec(`UPDATE clip_jobs SET status = 'ready', size_bytes = 1000 WHERE id = $1::uuid`, ids[0])

	// Another host with the switch and a recording of their own.
	other := f.h.signup("Ravi Other", "studio-other-"+strings.ReplaceAll(t.Name(), "/", "-")+"@test.dev", true)
	enableAIForUser(t, f.h, other.ID)
	forceFeature(t, f.h, other.ID, types.FeatureCloudRecording, true)
	forceFeature(t, f.h, other.ID, types.FeatureClips, true)
	theirs := f.h.liveWebinar("Ravi's session", nil)
	f.h.endSession(theirs.ID)
	theirRec := f.h.insertTake(theirs.ID, "", f.starts, 5*time.Minute, false)

	recs := f.studioRecordings("")
	if len(recs.Recordings) != 1 || recs.Recordings[0].ID != theirRec {
		t.Fatalf("other host's recordings = %+v", recs)
	}
	if clips := f.studioClips(""); len(clips.Clips) != 0 {
		t.Fatalf("other host sees clips: %+v", clips)
	}
	// Nor plan the first host's clip: not their session.
	res, raw := f.h.do(http.MethodPatch, f.path+"/clips/"+ids[0]+"/plan", types.ClipPlanInput{Status: types.ClipPlanIdea})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("plan another host's clip: %d %s", res.StatusCode, raw)
	}
	// Nor reach it under their own session's path.
	res, raw = f.h.do(http.MethodPatch, "/api/host/webinars/"+theirs.ID+"/recordings/"+theirRec+"/clips/"+ids[0]+"/plan",
		types.ClipPlanInput{Status: types.ClipPlanIdea})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("plan through another recording: %d %s", res.StatusCode, raw)
	}

	// The first host still sees exactly their own.
	f.h.login(f.host.Email)
	recs = f.studioRecordings("")
	if len(recs.Recordings) != 1 || recs.Recordings[0].ID != f.rec {
		t.Fatalf("own recordings = %+v", recs)
	}
	if clips := f.studioClips(""); len(clips.Clips) != 2 {
		t.Fatalf("own clips = %d", len(clips.Clips))
	}
}
