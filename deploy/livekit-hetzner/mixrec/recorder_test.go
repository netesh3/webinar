package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	recID  = "0b6f3c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b"
	recID2 = "1c7f3c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b"
	slug   = "instant-webinar-0375"
	secret = "test-secret-test-secret-test-secret-32"
)

type fakeAPI struct {
	mu      sync.Mutex
	calls   []string
	results []Result
	failURL error
}

func (f *fakeAPI) UploadURL(_ context.Context, id string) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "url:"+id)
	if f.failURL != nil {
		return "", "", f.failURL
	}
	return "https://bucket.test/" + id + ".mp4?sig", "video/mp4", nil
}

func (f *fakeAPI) Complete(_ context.Context, id string, res Result) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "complete:"+id)
	f.results = append(f.results, res)
	return nil
}

type fakeRemux struct{ got [][]string }

func (f *fakeRemux) Remux(_ context.Context, segs []string, out string) (int64, error) {
	f.got = append(f.got, slices.Clone(segs))
	return 61000, os.WriteFile(out, bytes.Repeat([]byte("m"), 4096), 0o600)
}

type fakeUploader struct{ urls []string }

func (f *fakeUploader) Put(_ context.Context, url, contentType, path string) (int64, error) {
	if contentType != "video/mp4" {
		return 0, errors.New("content type " + contentType)
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	f.urls = append(f.urls, url)
	return info.Size(), nil
}

type rig struct {
	rec   *Recorder
	api   *fakeAPI
	remux *fakeRemux
	up    *fakeUploader
	dir   string
	now   time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{api: &fakeAPI{}, remux: &fakeRemux{}, up: &fakeUploader{}, dir: t.TempDir(),
		now: time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)}
	r.rec = NewRecorder(Settings{RecordDir: r.dir, Quiet: 5 * time.Second, Idle: 3 * time.Minute,
		MaxWait: 2 * time.Minute, Attempts: 2}, r.api, r.remux, r.up, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r.rec.now = func() time.Time { return r.now }
	return r
}

// segment writes a MediaMTX segment that started at, last written at mod.
func (r *rig) segment(t *testing.T, s string, at, mod time.Time, size int) string {
	t.Helper()
	dir := filepath.Join(r.dir, "rec", s)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, at.Local().Format("2006-01-02_15-04-05")+"-123456.mp4")
	if err := os.WriteFile(p, bytes.Repeat([]byte("x"), size), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mod, mod); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestParseSegmentStart(t *testing.T) {
	got, ok := parseSegmentStart("2026-10-22_10-15-30-250000.mp4")
	want := time.Date(2026, 10, 22, 10, 15, 30, 250_000_000, time.Local)
	if !ok || !got.Equal(want) {
		t.Fatalf("got %v %v, want %v", got, ok, want)
	}
	if _, ok := parseSegmentStart("notes.mp4"); ok {
		t.Fatal("parsed a name that is not a segment")
	}
}

// Only this job's segments: from its start (with slack), up to its stop, with media in them.
func TestSegmentsForAJob(t *testing.T) {
	r := newRig(t)
	if err := r.rec.Start(recID, slug); err != nil {
		t.Fatal(err)
	}
	start := r.now
	old := r.segment(t, slug, start.Add(-time.Hour), start.Add(-time.Hour), 4096)
	a := r.segment(t, slug, start.Add(2*time.Second), start.Add(10*time.Minute), 4096)
	b := r.segment(t, slug, start.Add(10*time.Minute), start.Add(20*time.Minute), 4096)
	empty := r.segment(t, slug, start.Add(21*time.Minute), start.Add(21*time.Minute), 100)
	r.segment(t, "other-webinar", start.Add(time.Minute), start.Add(time.Minute), 4096)

	r.now = start.Add(25 * time.Minute)
	_ = r.rec.Stop(recID)
	after := r.segment(t, slug, start.Add(26*time.Minute), start.Add(26*time.Minute), 4096)

	j := r.rec.jobs[recID]
	segs, err := r.rec.segments(j)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, s := range segs {
		got = append(got, s.path)
	}
	if !slices.Equal(got, []string{a, b}) {
		t.Fatalf("segments = %v, want %v (not %v, %v, %v)", got, []string{a, b}, old, empty, after)
	}
}

// Stop, then wait for quiet, then remux, upload and report; the segments go once the API has it.
func TestStopFinalizesAndUploads(t *testing.T) {
	r := newRig(t)
	_ = r.rec.Start(recID, slug)
	start := r.now
	seg := r.segment(t, slug, start.Add(time.Second), start.Add(30*time.Minute), 8192)

	r.now = start.Add(30 * time.Minute)
	_ = r.rec.Stop(recID)
	if due := r.rec.Due(); len(due) != 0 {
		t.Fatalf("finished %d jobs before the segments went quiet", len(due))
	}
	r.now = r.now.Add(6 * time.Second)
	due := r.rec.Due()
	if len(due) != 1 {
		t.Fatalf("due = %d, want the stopped job", len(due))
	}
	r.rec.Finalize(context.Background(), due[0])

	if len(r.remux.got) != 1 || !slices.Equal(r.remux.got[0], []string{seg}) {
		t.Fatalf("remuxed %v", r.remux.got)
	}
	if !slices.Equal(r.api.calls, []string{"url:" + recID, "complete:" + recID}) {
		t.Fatalf("api calls = %v", r.api.calls)
	}
	if res := r.api.results[0]; res.SizeBytes != 4096 || res.DurationMs != 61000 || res.Error != "" {
		t.Fatalf("report = %+v", res)
	}
	if len(r.up.urls) != 1 || !strings.Contains(r.up.urls[0], recID) {
		t.Fatalf("uploads = %v", r.up.urls)
	}
	if _, err := os.Stat(seg); !os.IsNotExist(err) {
		t.Fatal("segment left behind after a successful upload")
	}
	if len(r.rec.jobs) != 0 {
		t.Fatal("job kept after it finished")
	}
}

// A job nobody stops is finished once its segments have been idle for Idle.
func TestIdleJobFinishesItself(t *testing.T) {
	r := newRig(t)
	_ = r.rec.Start(recID, slug)
	start := r.now
	r.segment(t, slug, start.Add(time.Second), start.Add(5*time.Minute), 4096)
	r.now = start.Add(7 * time.Minute)
	if due := r.rec.Due(); len(due) != 0 {
		t.Fatal("finished a job still inside its idle window")
	}
	r.now = start.Add(8*time.Minute + time.Second)
	due := r.rec.Due()
	if len(due) != 1 {
		t.Fatalf("due = %d, want the idle job", len(due))
	}
	r.rec.Finalize(context.Background(), due[0])
	if len(r.api.results) != 1 || r.api.results[0].SizeBytes == 0 {
		t.Fatalf("results = %+v", r.api.results)
	}
}

// Nothing recorded: the API is told it failed, straight away.
func TestNoSegmentsReportsFailure(t *testing.T) {
	r := newRig(t)
	_ = r.rec.Start(recID, slug)
	r.now = r.now.Add(time.Minute)
	_ = r.rec.Stop(recID)
	r.now = r.now.Add(10 * time.Second)
	due := r.rec.Due()
	if len(due) != 1 {
		t.Fatalf("due = %d", len(due))
	}
	r.rec.Finalize(context.Background(), due[0])
	if len(r.api.results) != 1 || r.api.results[0].Error == "" {
		t.Fatalf("results = %+v, want a failure report", r.api.results)
	}
}

// A failing upload is retried later, and after Attempts the API is told it failed.
func TestUploadFailureRetriesThenReports(t *testing.T) {
	r := newRig(t)
	r.api.failURL = errors.New("api down")
	_ = r.rec.Start(recID, slug)
	start := r.now
	seg := r.segment(t, slug, start.Add(time.Second), start.Add(time.Minute), 4096)
	r.now = start.Add(time.Minute)
	_ = r.rec.Stop(recID)
	r.now = r.now.Add(10 * time.Second)
	r.rec.Finalize(context.Background(), r.rec.Due()[0])
	if len(r.api.results) != 0 || len(r.rec.jobs) != 1 {
		t.Fatalf("gave up after one failure: results %v", r.api.results)
	}
	if due := r.rec.Due(); len(due) != 0 {
		t.Fatal("retried before the backoff")
	}
	r.now = r.now.Add(time.Minute)
	r.rec.Finalize(context.Background(), r.rec.Due()[0])
	if len(r.api.results) != 1 || r.api.results[0].Error == "" || len(r.rec.jobs) != 0 {
		t.Fatalf("after %d attempts: results %+v jobs %d", 2, r.api.results, len(r.rec.jobs))
	}
	if _, err := os.Stat(seg); err != nil {
		t.Fatal("segments of a failed recording should be kept for triage")
	}
}

// Jobs survive a restart of the container.
func TestJobsSurviveARestart(t *testing.T) {
	r := newRig(t)
	_ = r.rec.Start(recID, slug)
	_ = r.rec.Start(recID2, "other-webinar")
	_ = r.rec.Stop(recID)
	again := NewRecorder(Settings{RecordDir: r.dir}, r.api, r.remux, r.up, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := again.Load(); err != nil {
		t.Fatal(err)
	}
	if len(again.jobs) != 2 || again.jobs[recID].StopAt.IsZero() || !again.jobs[recID2].StopAt.IsZero() {
		t.Fatalf("restored %+v", again.jobs)
	}
}

func TestHandlerAuthAndValidation(t *testing.T) {
	r := newRig(t)
	srv := httptest.NewServer(Handler(r.rec, secret))
	defer srv.Close()
	post := func(path, sec, body string) int {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader(body))
		if sec != "" {
			req.Header.Set("X-Mixrec-Secret", sec)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	good := `{"recordingId":"` + recID + `","slug":"` + slug + `"}`
	if got := post("/v1/start", "", good); got != http.StatusUnauthorized {
		t.Fatalf("no secret: %d", got)
	}
	if got := post("/v1/start", "nope", good); got != http.StatusUnauthorized {
		t.Fatalf("wrong secret: %d", got)
	}
	if got := post("/v1/start", secret, `{"recordingId":"`+recID+`","slug":"../../etc"}`); got != http.StatusUnprocessableEntity {
		t.Fatalf("path in slug: %d", got)
	}
	if got := post("/v1/start", secret, good); got != http.StatusOK {
		t.Fatalf("start: %d", got)
	}
	if got := post("/v1/cancel", secret, good); got != http.StatusOK || len(r.rec.jobs) != 0 {
		t.Fatalf("cancel: %d, jobs %d", got, len(r.rec.jobs))
	}
	if got := post("/v1/stop", secret, good); got != http.StatusOK {
		t.Fatalf("stop of an unknown job: %d, want ok", got)
	}
}

/* The real ffmpeg, when there is one: two fragmented MP4 segments shaped like MediaMTX's
 * (H.264 + AAC, fMP4) join into one MP4 whose duration is the sum. */
func TestFFmpegRemuxFragmentedSegments(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	dir := t.TempDir()
	var segs []string
	for i, secs := range []string{"2", "3"} {
		p := filepath.Join(dir, fmt.Sprintf("seg%d.mp4", i))
		cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
			"-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440",
			"-t", secs, "-c:v", "libx264", "-g", "30", "-c:a", "aac",
			"-movflags", "frag_keyframe+empty_moov+default_base_moof", p)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("ffmpeg cannot make test segments: %v %s", err, out)
		}
		segs = append(segs, p)
	}
	out := filepath.Join(dir, "out.mp4")
	dur, err := ffmpegRemuxer{}.Remux(context.Background(), segs, out)
	if err != nil {
		t.Fatal(err)
	}
	if dur < 4800 || dur > 5300 {
		t.Fatalf("duration = %dms, want ~5000", dur)
	}
}

func TestConcatListQuotes(t *testing.T) {
	got := concatList([]string{"/recordings/rec/a/x'y.mp4"})
	if got != "file '/recordings/rec/a/x'\\''y.mp4'\n" {
		t.Fatalf("got %q", got)
	}
}
