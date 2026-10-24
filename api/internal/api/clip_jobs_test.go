package api_test

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Clips and reels (clip_jobs.go, reels.go): made from a recording behind the clips switch,
 * queued with everything the render needs settled (where each stretch lies in its take, the
 * burned-in captions), post text written in the brand voice, then claimed, made and reported
 * by the video server over the mix recorder's secret; counted in the host's storage and
 * deleted with the recording. */

const clipPostsReply = `{"posts": [
  {"platform": "linkedin", "title": "", "text": "Pay yourself first. Here is why.", "hashtags": ["#money", "personal finance"]},
  {"platform": "youtube_shorts", "title": "Pay yourself first", "text": "One rule.", "hashtags": ["Shorts", "money"]}
]}`

const reelsReply = `{"reels": [
  {"title": "Money rules", "hook": "Two rules that stick", "why": "Two short rules.",
   "moments": [{"startSec": 120, "endSec": 130}, {"startSec": 300, "endSec": 312}, {"startSec": 650, "endSec": 662}]},
  {"title": "Only one", "hook": "x", "why": "", "moments": [{"startSec": 120, "endSec": 130}]}
]}`

// clipStore is disk storage that signs like object storage, and says every file is there.
type clipStore struct{ *media.Disk }

func (clipStore) PresignedPutURL(_ context.Context, key, contentType string, _ time.Duration) (string, error) {
	return "https://bucket.test/put/" + key + "?type=" + contentType, nil
}

func (clipStore) PresignedURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://bucket.test/get/" + key + "?signed=1", nil
}

func (clipStore) PresignedGetURL(_ context.Context, key, filename, _ string, _ bool, _ time.Duration) (string, error) {
	return "https://bucket.test/get/" + key + "?name=" + filename, nil
}

func (clipStore) Stat(context.Context, string) (int64, error) { return 1, nil }

// clipSession is highlightSession with the video server's secret and signing storage.
func clipSession(t *testing.T) highlightFixture {
	t.Helper()
	h, model := aiHarness(t, highlightsReply, func(c *config.Config) { c.MixRecSecret = mixRecSecret })
	model.bySchema = map[string]string{"clip_posts": clipPostsReply, "reels": reelsReply}
	api.SetRecordings(h.server, clipStore{h.recordings})
	host := recapHost(t, h)
	forceFeature(t, h, host.ID, types.FeatureCloudRecording, true)
	forceFeature(t, h, host.ID, types.FeatureClips, true)
	wb := h.liveWebinar("Money basics", nil)
	h.endSession(wb.ID)
	ctx := context.Background()
	start := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	off := func(sec int) time.Time { return start.Add(time.Duration(sec) * time.Second) }
	rec := h.insertTake(wb.ID, "", start, 10*time.Minute, false)
	take2 := h.insertTake(wb.ID, rec, off(15*60), 5*time.Minute, false)
	var segs []store.TranscriptSegment
	for s := 0; s < 20*60; s += 8 {
		if s >= 10*60 && s < 15*60 {
			continue
		}
		segs = append(segs, store.TranscriptSegment{
			Identity: "user_" + host.ID, Start: ms(off(s)), End: ms(off(s + 7)),
			Text: "Sentence at " + strconv.Itoa(s) + " seconds. And another one here.",
		})
	}
	if err := h.store.SaveSessionTranscript(ctx, wb.ID, "large-v3", segs); err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveBrandVoice(ctx, host.ID, store.BrandVoiceRow{Tone: "Warm and direct"}); err != nil {
		t.Fatal(err)
	}
	return highlightFixture{h: h, model: model, host: host, wb: wb, rec: rec, take2: take2, ctx: ctx, starts: start,
		path: "/api/host/webinars/" + wb.ID + "/recordings/" + rec}
}

func (f highlightFixture) clips() types.ClipsResponse {
	f.h.t.Helper()
	res, raw := f.h.do(http.MethodGet, f.path+"/clips", nil)
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("clips: %d %s", res.StatusCode, raw)
	}
	var out types.ClipsResponse
	f.h.decode(raw, &out)
	return out
}

func (f highlightFixture) claim() map[string]any {
	f.h.t.Helper()
	res, raw := f.h.internal("/api/internal/clip-jobs/claim", mixRecSecret, struct{}{})
	if res.StatusCode != http.StatusOK {
		f.h.t.Fatalf("claim: %d %s", res.StatusCode, raw)
	}
	var out map[string]any
	f.h.decode(raw, &out)
	return out
}

func TestClipsAreMadeOnTheVideoServer(t *testing.T) {
	f := clipSession(t)
	res, raw := f.h.do(http.MethodPost, f.path+"/clips", types.CreateClipsRequest{
		Kind: types.ClipKindClip, SourceID: "h1", Title: "Pay yourself first",
		Ranges:   []types.ClipRange{{StartSec: 120, EndSec: 150}},
		Formats:  []string{types.ClipFormatVertical, types.ClipFormatSquare, types.ClipFormatVertical},
		Captions: true, Hook: `  "Pay yourself first, always" `,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	var created types.ClipsResponse
	f.h.decode(raw, &created)
	if !created.Available || len(created.Clips) != 2 || created.Server.State != types.ClipServerReady {
		t.Fatalf("created = %+v", created)
	}
	c := created.Clips[0]
	if c.Status != types.ClipQueued || c.Hook != "Pay yourself first, always" || c.DurationSec != 30 ||
		len(c.Ranges) != 1 || c.Ranges[0].StartSec != 120 {
		t.Fatalf("clip = %+v", c)
	}
	// The post text, once for both formats, in the brand voice, hashtags tidied.
	if c.PostStatus != types.ClipPostReady || len(c.Posts) != 2 || c.Posts[0].Platform != types.ClipPlatformShorts ||
		strings.Join(c.Posts[1].Hashtags, ",") != "money,personalfinance" {
		t.Fatalf("posts = %s %+v", c.PostStatus, c.Posts)
	}
	if f.model.callsFor("clip_posts") != 1 {
		t.Fatalf("post calls = %d", f.model.callsFor("clip_posts"))
	}
	prompt := userMessage(f.model.lastBodyFor("clip_posts"))
	for _, want := range []string{"Warm and direct", "Sentence at 120 seconds.", "30 seconds"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("post prompt lacks %q: %.400s", want, prompt)
		}
	}
	var subs string
	if err := f.h.store.Pool().QueryRow(f.ctx, `SELECT subtitles FROM clip_jobs WHERE format = '9x16'`).Scan(&subs); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(subs, "PlayResY: 1920") || !strings.Contains(subs, ",Hook,,") || !strings.Contains(subs, "{\\c&H00D7FF&}Sentence{\\c&HFFFFFF&}") {
		t.Fatalf("subtitles:\n%s", subs)
	}

	// The video server claims one: signed reads of just that stretch, the script, the size.
	claim := f.claim()
	job, _ := claim["job"].(map[string]any)
	if job == nil {
		t.Fatalf("claim = %v", claim)
	}
	id := job["id"].(string)
	inputs := job["inputs"].([]any)
	in := inputs[0].(map[string]any)
	if len(inputs) != 1 || !strings.Contains(in["url"].(string), "bucket.test/get/cc/") || in["startSec"].(float64) != 120 || in["durationSec"].(float64) != 30 {
		t.Fatalf("job = %v", job)
	}
	if job["subtitles"] == "" || job["leaseSec"].(float64) < 60 {
		t.Fatalf("job = %v", job)
	}
	if got := f.clips().Clips; got[0].Status != types.ClipProcessing && got[1].Status != types.ClipProcessing {
		t.Fatalf("after the claim: %+v", got)
	}
	res, raw = f.h.internal("/api/internal/clip-jobs/"+id+"/progress", mixRecSecret, map[string]int{"percent": 40})
	if res.StatusCode != http.StatusOK || strings.Contains(string(raw), "stop") {
		t.Fatalf("progress: %d %s", res.StatusCode, raw)
	}
	res, raw = f.h.internal("/api/internal/clip-jobs/"+id+"/upload-url", mixRecSecret, struct{}{})
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "bucket.test/put/clips/") {
		t.Fatalf("upload url: %d %s", res.StatusCode, raw)
	}
	res, raw = f.h.internal("/api/internal/clip-jobs/"+id+"/complete", mixRecSecret, map[string]any{"sizeBytes": 123456, "durationMs": 30000})
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("complete: %d %s", res.StatusCode, raw)
	}
	// Ready: downloadable, and in the host's storage.
	var ready types.Clip
	for _, c := range f.clips().Clips {
		if c.ID == id {
			ready = c
		}
	}
	if ready.Status != types.ClipReady || ready.SizeBytes != 123456 || ready.Progress != 100 {
		t.Fatalf("ready = %+v", ready)
	}
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Jar: f.h.client.Jar}
	fres, err := noRedirect.Get(f.h.srv.URL + f.path + "/clips/" + id + "/file")
	if err != nil {
		t.Fatal(err)
	}
	fres.Body.Close()
	if loc := fres.Header.Get("Location"); fres.StatusCode != http.StatusTemporaryRedirect || !strings.Contains(loc, "/clips/") || !strings.Contains(loc, "Pay-yourself-first-") {
		t.Fatalf("file: %d %s", fres.StatusCode, loc)
	}
	st, err := f.h.store.RecordingStorageFor(f.ctx, f.host.ID, 0)
	if err != nil || st.UsedBytes != 2000+123456 {
		t.Fatalf("storage = %+v %v", st, err)
	}

	// The other fails on the server: tried again, then failed in plain words.
	for try := 1; try <= 3; try++ {
		job, _ := f.claim()["job"].(map[string]any)
		if job == nil {
			t.Fatalf("try %d: nothing to claim", try)
		}
		res, raw := f.h.internal("/api/internal/clip-jobs/"+job["id"].(string)+"/complete", mixRecSecret,
			map[string]any{"error": "ffmpeg: exit 1", "retry": true})
		if res.StatusCode != http.StatusNoContent {
			t.Fatalf("fail: %d %s", res.StatusCode, raw)
		}
	}
	if job, _ := f.claim()["job"].(map[string]any); job != nil {
		t.Fatalf("a fourth try: %v", job)
	}
	for _, c := range f.clips().Clips {
		if c.ID != id && (c.Status != types.ClipFailed || !strings.Contains(c.Error, "couldn't make this clip")) {
			t.Fatalf("failed = %+v", c)
		}
	}

	// Deleted with the recording: the row goes and its file is swept from storage.
	res, raw = f.h.do(http.MethodDelete, "/api/host/webinars/"+f.wb.ID+"/recordings/"+f.rec, nil)
	if res.StatusCode/100 != 2 {
		t.Fatalf("delete recording: %d %s", res.StatusCode, raw)
	}
	var rows, blobs int
	_ = f.h.store.Pool().QueryRow(f.ctx, `SELECT count(*) FROM clip_jobs`).Scan(&rows)
	_ = f.h.store.Pool().QueryRow(f.ctx, `SELECT count(*) FROM clip_blob_deletions WHERE storage_key LIKE 'clips/%'`).Scan(&blobs)
	if rows != 0 || blobs != 1 {
		t.Fatalf("after the recording went: %d rows, %d files to delete", rows, blobs)
	}
	api.SweepClipBlobs(f.h.server, f.ctx)
	_ = f.h.store.Pool().QueryRow(f.ctx, `SELECT count(*) FROM clip_blob_deletions`).Scan(&blobs)
	if blobs != 0 {
		t.Fatalf("files left to delete: %d", blobs)
	}
}

func TestClipsWaitWhileASessionIsLive(t *testing.T) {
	f := clipSession(t)
	res, raw := f.h.do(http.MethodPost, f.path+"/clips", types.CreateClipsRequest{
		Kind: types.ClipKindReel, Title: "Two rules", Formats: []string{types.ClipFormatWide},
		Ranges: []types.ClipRange{{StartSec: 120, EndSec: 135}, {StartSec: 650, EndSec: 665}},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", res.StatusCode, raw)
	}
	f.h.liveWebinar("Someone else live", nil)
	if got := f.claim(); got["job"] != nil || got["wait"] != "live" {
		t.Fatalf("claim while live = %v", got)
	}
	if st := f.clips().Server; st.State != types.ClipServerBusy || !strings.Contains(st.Text, "live session") {
		t.Fatalf("server = %+v", st)
	}
}

func TestClipsRefuseWhatCannotBeCut(t *testing.T) {
	f := clipSession(t)
	for name, c := range map[string]struct {
		req  types.CreateClipsRequest
		code string
	}{
		"across the break": {types.CreateClipsRequest{Kind: types.ClipKindClip, Formats: []string{"9x16"},
			Ranges: []types.ClipRange{{StartSec: 590, EndSec: 610}}}, "bad_range"},
		"a reel of one": {types.CreateClipsRequest{Kind: types.ClipKindReel, Formats: []string{"9x16"},
			Ranges: []types.ClipRange{{StartSec: 100, EndSec: 120}}}, "bad_length"},
		"too short": {types.CreateClipsRequest{Kind: types.ClipKindClip, Formats: []string{"9x16"},
			Ranges: []types.ClipRange{{StartSec: 100, EndSec: 102}}}, "bad_length"},
		"no format": {types.CreateClipsRequest{Kind: types.ClipKindClip, Formats: []string{"4x3"},
			Ranges: []types.ClipRange{{StartSec: 100, EndSec: 130}}}, "bad_format"},
	} {
		res, raw := f.h.do(http.MethodPost, f.path+"/clips", c.req)
		if res.StatusCode != http.StatusBadRequest || !strings.Contains(string(raw), c.code) {
			t.Errorf("%s: %d %s", name, res.StatusCode, raw)
		}
	}
	// Without the switch: nothing.
	forceFeature(t, f.h, f.host.ID, types.FeatureClips, false)
	res, raw := f.h.do(http.MethodGet, f.path+"/clips", nil)
	f.h.wantError(res, raw, http.StatusForbidden, "feature_off")
}

func TestReelsAreSuggestedAndSnapped(t *testing.T) {
	f := clipSession(t)
	look := func() types.ReelsResponse {
		t.Helper()
		res, raw := f.h.do(http.MethodGet, f.path+"/reels", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("reels: %d %s", res.StatusCode, raw)
		}
		var out types.ReelsResponse
		f.h.decode(raw, &out)
		return out
	}
	// A look never plans them, and they do not wait on the highlights (none were found).
	if got := look(); got.Status != types.HighlightsNotStarted || len(got.Reels) != 0 {
		t.Fatalf("before asking = %+v", got)
	}
	if f.model.callCount() != 0 {
		t.Fatalf("a look called the model %d times", f.model.callCount())
	}
	res, raw := f.h.do(http.MethodPost, f.path+"/reels", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("suggest reels: %d %s", res.StatusCode, raw)
	}
	var got types.ReelsResponse
	f.h.decode(raw, &got)
	if got.Status != types.AIStatusReady || len(got.Reels) != 1 {
		t.Fatalf("reels = %+v", got)
	}
	r := got.Reels[0]
	if r.ID != "r1" || r.Hook != "Two rules that stick" || len(r.Moments) != 3 || r.Moments[2].PartID != f.take2 ||
		r.DurationSec < types.ReelMinSec || r.DurationSec > types.ReelMaxSec {
		t.Fatalf("reel = %+v", r)
	}
	for _, m := range r.Moments {
		if d := m.EndSec - m.StartSec; d < types.ReelMomentMinSec || d > types.ReelMomentMaxSec+1 || m.Quote == "" {
			t.Fatalf("moment = %+v (%v s)", m, d)
		}
	}
	if f.model.callsFor("reels") != 1 {
		t.Fatalf("calls = %d", f.model.callsFor("reels"))
	}
	if again := look(); again.Status != types.AIStatusReady || len(again.Reels) != 1 || f.model.callsFor("reels") != 1 {
		t.Fatalf("kept reels = %+v, calls %d", again, f.model.callsFor("reels"))
	}
	if f.model.callsFor("highlights") != 0 {
		t.Fatalf("reels asked for highlights %d times", f.model.callsFor("highlights"))
	}
}

func TestClipsMakeNowIsForAdmins(t *testing.T) {
	f := clipSession(t)
	res, raw := f.h.do(http.MethodPost, "/api/admin/clips/make-now", nil)
	f.h.wantError(res, raw, http.StatusForbidden, "not_an_admin")
	if got := f.clips(); got.CanMakeNow {
		t.Fatalf("a host may make it now: %+v", got)
	}
}

func TestClipModelSetting(t *testing.T) {
	h := newHarness(t, func(c *config.Config) { c.AIModelHighlights = "gpt-5-mini" })
	for feature, want := range map[string]string{
		types.AIFeatureHighlights: "gpt-5-mini", types.AIFeatureReels: "gpt-5-mini", types.AIFeatureClipPosts: "gpt-5-mini",
		types.AIFeatureRepurpose: "", types.AIFeatureWebinarSetup: "",
	} {
		if got := api.AIModelFor(h.server, feature); got != want {
			t.Errorf("%s: model %q, want %q", feature, got, want)
		}
	}
}
