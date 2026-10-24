package main

/* The mix recorder: records an edge webinar from the audience mix already running on this box.
 *
 * The API (api/internal/api/mixrec.go) gives the running mix a second RTMP output to MediaMTX,
 * rec/{slug}, and MediaMTX records every rec/* path as fMP4 segments under RecordDir
 * (mediamtx.yml.template: recordPath /recordings/%path/%Y-%m-%d_%H-%M-%S-%f). This process:
 *
 *   start   remembers the job (recording id, slug, when);
 *   stop    notes when it stopped, waits for the segments to stop growing (the API has taken
 *           the output off the mix, so MediaMTX closes the file), joins them into one MP4
 *           (ffmpeg -c copy, no re-encode), PUTs it to a URL the API signs for that recording's
 *           storage key, and reports size and duration to the API;
 *   cancel  forgets a job that never got its output (the mix refused it).
 *
 * A job nobody stops — the webinar ended, the API never got through — is finished the same way
 * once its segments have been idle for Idle. Jobs are kept in a state file, so a restart of this
 * container picks them up again. Segments are deleted only after the API has the file.
 */

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// API is the webinar API's side: where to upload, and the report.
type API interface {
	UploadURL(ctx context.Context, recordingID string) (url, contentType string, err error)
	Complete(ctx context.Context, recordingID string, res Result) error
}

// Remuxer joins segments into one MP4 at out and reports its duration.
type Remuxer interface {
	Remux(ctx context.Context, segments []string, out string) (durationMs int64, err error)
}

// Uploader PUTs a file to a signed URL and reports the bytes sent.
type Uploader interface {
	Put(ctx context.Context, url, contentType, path string) (int64, error)
}

// Result is what the API is told when a job is done.
type Result struct {
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

// Job is one recording.
type Job struct {
	RecordingID string    `json:"recordingId"`
	Slug        string    `json:"slug"`
	StartedAt   time.Time `json:"startedAt"`
	StopAt      time.Time `json:"stopAt,omitempty"`
	Attempts    int       `json:"attempts,omitempty"`
	NextTry     time.Time `json:"nextTry,omitempty"`

	finalizing bool
}

type Settings struct {
	RecordDir string        // MediaMTX's record root, shared with its container
	Quiet     time.Duration // segments unchanged this long after stop: the file is closed
	Idle      time.Duration // an unstopped job whose segments are unchanged this long is over
	MaxWait   time.Duration // after stop, finish anyway once this has passed
	Attempts  int           // finalize tries before the API is told it failed
}

type Recorder struct {
	set   Settings
	api   API
	remux Remuxer
	up    Uploader
	log   *slog.Logger
	now   func() time.Time

	mu   sync.Mutex
	jobs map[string]*Job
}

var (
	slugRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	idRe   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

var errBadJob = errors.New("bad recording id or slug")

func NewRecorder(set Settings, api API, remux Remuxer, up Uploader, log *slog.Logger) *Recorder {
	if set.Quiet <= 0 {
		set.Quiet = 5 * time.Second
	}
	if set.Idle <= 0 {
		set.Idle = 3 * time.Minute
	}
	if set.MaxWait <= 0 {
		set.MaxWait = 2 * time.Minute
	}
	if set.Attempts <= 0 {
		set.Attempts = 5
	}
	return &Recorder{set: set, api: api, remux: remux, up: up, log: log, now: time.Now, jobs: map[string]*Job{}}
}

func (r *Recorder) stateDir() string  { return filepath.Join(r.set.RecordDir, ".mixrec") }
func (r *Recorder) statePath() string { return filepath.Join(r.stateDir(), "jobs.json") }

// Active is whether a mix recording is in progress here (the clip maker waits while one is).
func (r *Recorder) Active() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.jobs) > 0
}

// Load restores the jobs a previous run left.
func (r *Recorder) Load() error {
	raw, err := os.ReadFile(r.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var jobs []*Job
	if err := json.Unmarshal(raw, &jobs); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, j := range jobs {
		if idRe.MatchString(j.RecordingID) && slugRe.MatchString(j.Slug) {
			r.jobs[j.RecordingID] = j
		}
	}
	return nil
}

// saveLocked writes the jobs; r.mu must be held.
func (r *Recorder) saveLocked() {
	jobs := make([]*Job, 0, len(r.jobs))
	for _, j := range r.jobs {
		jobs = append(jobs, j)
	}
	sort.Slice(jobs, func(a, b int) bool { return jobs[a].StartedAt.Before(jobs[b].StartedAt) })
	raw, _ := json.MarshalIndent(jobs, "", "  ")
	if err := os.MkdirAll(r.stateDir(), 0o750); err != nil {
		r.log.Error("state dir", "error", err)
		return
	}
	tmp := r.statePath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err == nil {
		err = os.Rename(tmp, r.statePath())
		if err != nil {
			r.log.Error("state save", "error", err)
		}
	} else {
		r.log.Error("state save", "error", err)
	}
}

// Start registers a job. Idempotent for the same id.
func (r *Recorder) Start(id, slug string) error {
	if !idRe.MatchString(id) || !slugRe.MatchString(slug) {
		return errBadJob
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if j, ok := r.jobs[id]; ok {
		if j.Slug != slug {
			return errBadJob
		}
		return nil
	}
	r.jobs[id] = &Job{RecordingID: id, Slug: slug, StartedAt: r.now().UTC()}
	r.saveLocked()
	r.log.Info("recording started", "recording", id, "slug", slug)
	return nil
}

// Stop marks a job stopped; it is finished once its segments are closed. Unknown ids are
// not an error: the job may already be done.
func (r *Recorder) Stop(id string) error {
	if !idRe.MatchString(id) {
		return errBadJob
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if j, ok := r.jobs[id]; ok && j.StopAt.IsZero() {
		j.StopAt = r.now().UTC()
		r.saveLocked()
		r.log.Info("recording stopping", "recording", id, "slug", j.Slug)
	}
	return nil
}

// Cancel forgets a job whose output never reached the mix.
func (r *Recorder) Cancel(id string) error {
	if !idRe.MatchString(id) {
		return errBadJob
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if j, ok := r.jobs[id]; ok && !j.finalizing {
		delete(r.jobs, id)
		r.saveLocked()
	}
	return nil
}

// segment is one MediaMTX recording file.
type segment struct {
	path  string
	start time.Time
	mod   time.Time
	size  int64
}

/* MediaMTX names segments by their start, %Y-%m-%d_%H-%M-%S-%f (microseconds), in its local
 * time zone. Read here in this process's: both containers run without TZ, so both are UTC. */
const segmentLayout = "2006-01-02_15-04-05"

func parseSegmentStart(name string) (time.Time, bool) {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	if len(base) < len(segmentLayout) {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation(segmentLayout, base[:len(segmentLayout)], time.Local)
	if err != nil {
		return time.Time{}, false
	}
	if rest := base[len(segmentLayout):]; strings.HasPrefix(rest, "-") {
		var us int64
		if _, err := fmt.Sscanf(rest[1:], "%d", &us); err == nil {
			t = t.Add(time.Duration(us) * time.Microsecond)
		}
	}
	return t, true
}

// startSlack lets a segment begin a little before the job: the clocks of this container and
// MediaMTX's agree, but the API's start call and the push are not the same instant.
const startSlack = 10 * time.Second

// minSegment drops files with no media in them (an fMP4 header only).
const minSegment = 1024

// segments are a job's files, oldest first: rec/{slug} segments that began during the job.
func (r *Recorder) segments(j *Job) ([]segment, error) {
	dir := filepath.Join(r.set.RecordDir, "rec", j.Slug)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []segment
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".mp4" {
			continue
		}
		start, ok := parseSegmentStart(e.Name())
		if !ok || start.Before(j.StartedAt.Add(-startSlack)) {
			continue
		}
		if !j.StopAt.IsZero() && start.After(j.StopAt) {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() < minSegment {
			continue
		}
		out = append(out, segment{path: filepath.Join(dir, e.Name()), start: start, mod: info.ModTime(), size: info.Size()})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].start.Before(out[b].start) })
	return out, nil
}

func latest(segs []segment, floor time.Time) time.Time {
	t := floor
	for _, s := range segs {
		if s.mod.After(t) {
			t = s.mod
		}
	}
	return t
}

/* Due returns the jobs ready to finish, marked as finishing: stopped and quiet (or stopped
 * long enough), or never stopped and idle. */
func (r *Recorder) Due() []*Job {
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	var due []*Job
	changed := false
	for _, j := range r.jobs {
		if j.finalizing || now.Before(j.NextTry) {
			continue
		}
		segs, err := r.segments(j)
		if err != nil {
			r.log.Warn("list segments", "recording", j.RecordingID, "error", err)
			continue
		}
		if j.StopAt.IsZero() {
			if now.Sub(latest(segs, j.StartedAt)) < r.set.Idle {
				continue
			}
			// Idle is already far longer than quiet: due now.
			j.StopAt = now.UTC()
			changed = true
			r.log.Info("recording idle, finishing it", "recording", j.RecordingID, "slug", j.Slug)
		} else if now.Sub(latest(segs, j.StopAt)) < r.set.Quiet && now.Sub(j.StopAt) < r.set.MaxWait {
			continue
		}
		j.finalizing = true
		due = append(due, j)
	}
	if changed {
		r.saveLocked()
	}
	return due
}

// Finalize joins, uploads and reports one job. On a failure it is retried with backoff, and
// after Attempts the API is told it failed (the segments are left for MediaMTX's
// recordDeleteAfter, in case someone wants them).
func (r *Recorder) Finalize(ctx context.Context, j *Job) {
	res, err := r.finish(ctx, j)
	r.mu.Lock()
	j.finalizing = false
	if err == nil {
		delete(r.jobs, j.RecordingID)
		r.saveLocked()
		r.mu.Unlock()
		r.log.Info("recording uploaded", "recording", j.RecordingID, "slug", j.Slug,
			"sizeBytes", res.SizeBytes, "durationMs", res.DurationMs)
		return
	}
	j.Attempts++
	giveUp := errors.Is(err, errNoSegments) || j.Attempts >= r.set.Attempts
	if giveUp {
		delete(r.jobs, j.RecordingID)
	} else {
		j.NextTry = r.now().Add(time.Duration(j.Attempts) * 30 * time.Second)
	}
	attempts := j.Attempts
	r.saveLocked()
	r.mu.Unlock()

	if !giveUp {
		r.log.Warn("recording finalize failed, will retry", "recording", j.RecordingID,
			"attempt", attempts, "error", err)
		return
	}
	r.log.Error("recording failed", "recording", j.RecordingID, "slug", j.Slug, "error", err)
	if cerr := r.api.Complete(ctx, j.RecordingID, Result{Error: err.Error()}); cerr != nil {
		r.log.Warn("report failure", "recording", j.RecordingID, "error", cerr)
	}
}

var errNoSegments = errors.New("no recorded segments")

func (r *Recorder) finish(ctx context.Context, j *Job) (Result, error) {
	segs, err := r.segments(j)
	if err != nil {
		return Result{}, err
	}
	if len(segs) == 0 {
		return Result{}, errNoSegments
	}
	paths := make([]string, len(segs))
	for i, s := range segs {
		paths[i] = s.path
	}
	if err := os.MkdirAll(r.stateDir(), 0o750); err != nil {
		return Result{}, err
	}
	out := filepath.Join(r.stateDir(), j.RecordingID+".mp4")
	defer os.Remove(out)
	dur, err := r.remux.Remux(ctx, paths, out)
	if err != nil {
		return Result{}, fmt.Errorf("remux: %w", err)
	}
	url, contentType, err := r.api.UploadURL(ctx, j.RecordingID)
	if err != nil {
		return Result{}, fmt.Errorf("upload url: %w", err)
	}
	size, err := r.up.Put(ctx, url, contentType, out)
	if err != nil {
		return Result{}, fmt.Errorf("upload: %w", err)
	}
	res := Result{SizeBytes: size, DurationMs: dur}
	if err := r.api.Complete(ctx, j.RecordingID, res); err != nil {
		return Result{}, fmt.Errorf("report: %w", err)
	}
	for _, p := range paths {
		_ = os.Remove(p)
	}
	return res, nil
}

// Run finishes due jobs until ctx ends.
func (r *Recorder) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		for _, j := range r.Due() {
			go r.Finalize(context.WithoutCancel(ctx), j)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
