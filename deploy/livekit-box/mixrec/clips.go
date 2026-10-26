package main

/* The clip maker: renders the clips and reels hosts make from their recordings
 * (api/internal/api/clip_jobs.go), on this box, between sessions.
 *
 *   claim     every ClipEvery, unless a mix recording is in progress here, it asks the API for
 *             the next job. The API answers none while a session is live (or about to start)
 *             on this server, so a render never competes with a live session for the CPU.
 *   render    one job at a time: ffmpeg reads just the stretches it needs straight from
 *             signed URLs of the takes (an HTTP range read per stretch, no download of the
 *             whole recording), frames them for the format, stitches a reel's moments with
 *             hard cuts (a 50 ms audio fade at each so a cut never clicks), burns in the ASS
 *             captions and hook the API wrote (libass, with Inter), normalises loudness to
 *             -14 LUFS (what Reels, Shorts and TikTok play at) and writes an H.264/AAC MP4
 *             with +faststart. Under nice 19 and the idle I/O class, on ClipThreads threads,
 *             inside this container's CPU cap.
 *   report    progress every ClipBeat renews the job's lease; the API can answer "stop" (the
 *             job was deleted, or a session went live and the job is back in the queue), and
 *             ffmpeg is killed. Done, the MP4 is PUT to a URL the API signs and the size and
 *             length reported; failed, the error is reported and the API decides whether the
 *             job is tried again.
 *
 * Framing: a recording is one mixed picture of the session as the audience saw it, never a
 * separate camera, so a 9:16 or 1:1 clip either keeps the whole picture over a blurred,
 * darkened copy of itself ("fit") or fills the frame with the middle, left or right of it
 * (the host's choice: right suits a side-by-side layout, centre a single camera). */

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ClipAPI is the API's side of making clips.
type ClipAPI interface {
	// ClaimClip is the next job, or nil (wait says why, when it says anything).
	ClaimClip(ctx context.Context) (job *ClipJob, wait string, err error)
	// ClipProgress renews the lease; stop is non-empty when the job must be dropped.
	ClipProgress(ctx context.Context, id string, percent int) (stop string, err error)
	ClipUploadURL(ctx context.Context, id string) (url, contentType string, err error)
	ClipComplete(ctx context.Context, id string, res ClipResult) error
}

// ClipJob is one render, as the API hands it over.
type ClipJob struct {
	ID          string      `json:"id"`
	Format      string      `json:"format"`
	Width       int         `json:"width"`
	Height      int         `json:"height"`
	Framing     string      `json:"framing"`
	Inputs      []ClipInput `json:"inputs"`
	Subtitles   string      `json:"subtitles,omitempty"`
	DurationSec float64     `json:"durationSec"`
	LeaseSec    int         `json:"leaseSec"`
}

// ClipInput is one stretch of a take: a signed URL and where in it.
type ClipInput struct {
	URL         string  `json:"url"`
	StartSec    float64 `json:"startSec"`
	DurationSec float64 `json:"durationSec"`
}

// ClipResult is the report: a size, or an error.
type ClipResult struct {
	SizeBytes  int64  `json:"sizeBytes"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
	Retry      bool   `json:"retry,omitempty"`
}

// ClipRenderer renders a job to out, calling progress with the seconds made so far.
type ClipRenderer interface {
	Render(ctx context.Context, job ClipJob, assPath, out string, progress func(sec float64)) (durationMs int64, err error)
}

// ClipSettings are the clip maker's knobs.
type ClipSettings struct {
	Dir   string        // scratch space for the script and the result
	Every time.Duration // how often to ask for a job when idle
	Beat  time.Duration // how often to report progress
}

// Clipper claims and renders clip jobs, one at a time.
type Clipper struct {
	set    ClipSettings
	api    ClipAPI
	render ClipRenderer
	up     Uploader
	log    *slog.Logger
	// busy is a mix recording in progress here: no clip is started while one is.
	busy func() bool
}

func NewClipper(set ClipSettings, api ClipAPI, render ClipRenderer, up Uploader, busy func() bool, log *slog.Logger) *Clipper {
	if set.Every <= 0 {
		set.Every = 30 * time.Second
	}
	if set.Beat <= 0 {
		set.Beat = 20 * time.Second
	}
	return &Clipper{set: set, api: api, render: render, up: up, busy: busy, log: log}
}

// Run asks for jobs until ctx ends, straight on to the next after one is done.
func (c *Clipper) Run(ctx context.Context) {
	wait := time.Duration(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = c.set.Every
		if c.busy != nil && c.busy() {
			continue
		}
		if c.Once(ctx) {
			wait = 0
		}
	}
}

// Once claims and makes one job; true when there was one.
func (c *Clipper) Once(ctx context.Context) bool {
	job, waitWhy, err := c.api.ClaimClip(ctx)
	if err != nil {
		c.log.Warn("clips: claim", "error", err)
		return false
	}
	if job == nil {
		if waitWhy != "" {
			c.log.Debug("clips: waiting", "why", waitWhy)
		}
		return false
	}
	if !idRe.MatchString(job.ID) {
		c.log.Error("clips: bad job id", "id", job.ID)
		return false
	}
	c.make(ctx, *job)
	return true
}

// errStopped is a job the API asked us to drop.
var errStopped = errors.New("stopped by the API")

func (c *Clipper) make(parent context.Context, job ClipJob) {
	log := c.log.With("clip", job.ID, "format", job.Format, "seconds", job.DurationSec)
	start := time.Now()
	if err := os.MkdirAll(c.set.Dir, 0o750); err != nil {
		c.fail(parent, job, fmt.Errorf("scratch dir: %w", err), true)
		return
	}
	out := filepath.Join(c.set.Dir, job.ID+".mp4")
	assPath := ""
	defer func() {
		_ = os.Remove(out)
		if assPath != "" {
			_ = os.Remove(assPath)
		}
	}()
	if job.Subtitles != "" {
		assPath = filepath.Join(c.set.Dir, job.ID+".ass")
		if err := os.WriteFile(assPath, []byte(job.Subtitles), 0o600); err != nil {
			c.fail(parent, job, fmt.Errorf("write captions: %w", err), true)
			return
		}
	}

	// The render, under a deadline, cancelled when the API says stop.
	limit := min(time.Duration(job.DurationSec*float64(time.Second))*30+5*time.Minute, 90*time.Minute)
	ctx, cancel := context.WithTimeout(parent, limit)
	defer cancel()
	var mu sync.Mutex
	made, stop := 0.0, ""
	beatDone := make(chan struct{})
	go func() {
		defer close(beatDone)
		t := time.NewTicker(c.set.Beat)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			mu.Lock()
			pct := 0
			if job.DurationSec > 0 {
				pct = int(100 * made / job.DurationSec)
			}
			mu.Unlock()
			why, err := c.api.ClipProgress(ctx, job.ID, min(pct, 99))
			if err != nil {
				log.Warn("clips: progress", "error", err)
				continue
			}
			if why != "" {
				mu.Lock()
				stop = why
				mu.Unlock()
				cancel()
				return
			}
		}
	}()
	durMs, err := c.render.Render(ctx, job, assPath, out, func(sec float64) {
		mu.Lock()
		made = sec
		mu.Unlock()
	})
	cancel()
	<-beatDone
	mu.Lock()
	stopped := stop
	mu.Unlock()
	if stopped != "" {
		log.Info("clips: dropped", "why", stopped)
		return
	}
	if err != nil {
		if parent.Err() != nil {
			return // shutting down: the lease runs out and the job is claimed again
		}
		c.fail(parent, job, err, true)
		return
	}

	url, ct, err := c.api.ClipUploadURL(parent, job.ID)
	if err != nil {
		c.fail(parent, job, fmt.Errorf("upload url: %w", err), true)
		return
	}
	size, err := c.up.Put(parent, url, ct, out)
	if err != nil {
		c.fail(parent, job, fmt.Errorf("upload: %w", err), true)
		return
	}
	if err := c.api.ClipComplete(parent, job.ID, ClipResult{SizeBytes: size, DurationMs: durMs}); err != nil {
		log.Warn("clips: complete", "error", err)
		return
	}
	log.Info("clips: made", "bytes", size, "ms", durMs, "took", time.Since(start).Round(time.Second).String())
}

func (c *Clipper) fail(ctx context.Context, job ClipJob, err error, retry bool) {
	c.log.Warn("clips: failed", "clip", job.ID, "error", err)
	msg := err.Error()
	if len(msg) > 2000 {
		msg = msg[:2000]
	}
	if rerr := c.api.ClipComplete(ctx, job.ID, ClipResult{Error: msg, Retry: retry}); rerr != nil {
		c.log.Warn("clips: report failure", "clip", job.ID, "error", rerr)
	}
}

// ---------------------------------------------------------------- ffmpeg

// ffmpegClips renders with ffmpeg at low priority.
type ffmpegClips struct {
	// Threads caps the encoder's threads.
	Threads int
	// Ionice is whether ionice works here (checked once at start).
	Ionice bool
}

// renderCommand is the whole command line: the priority wrappers, then ffmpeg.
func (f ffmpegClips) renderCommand(job ClipJob, assPath, out string) []string {
	cmd := []string{"nice", "-n", "19"}
	if f.Ionice {
		cmd = append(cmd, "ionice", "-c", "3")
	}
	return append(append(cmd, "ffmpeg"), clipArgs(job, assPath, out, max(f.Threads, 1))...)
}

func (f ffmpegClips) Render(ctx context.Context, job ClipJob, assPath, out string, progress func(sec float64)) (int64, error) {
	argv := f.renderCommand(job, assPath, out)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...) // #nosec G204 -- fixed binaries; URLs and paths are arguments, never a shell
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 8 << 10}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	readProgress(stdout, progress)
	if err := cmd.Wait(); err != nil {
		return 0, fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return probeDurationMs(ctx, out)
}

// readProgress reads ffmpeg's -progress lines (out_time_us=…) until the pipe closes.
func readProgress(r io.Reader, progress func(sec float64)) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok || (k != "out_time_us" && k != "out_time_ms") {
			continue
		}
		if us, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && us > 0 && progress != nil {
			progress(float64(us) / 1e6) // out_time_ms is microseconds too, despite its name
		}
	}
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	_, _ = l.w.Write(q)
	return len(p), nil
}

// clipFPS is every clip's frame rate.
const clipFPS = 30

/* clipArgs is ffmpeg's arguments for a job: each stretch an input read from its URL (only
 * that stretch: -ss before -i seeks, -t stops), one filter graph (framing, the reel's cuts,
 * captions, loudness), and the encode. */
func clipArgs(job ClipJob, assPath, out string, threads int) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y"}
	for _, in := range job.Inputs {
		if strings.HasPrefix(in.URL, "http://") || strings.HasPrefix(in.URL, "https://") {
			args = append(args, "-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10")
		}
		args = append(args, "-ss", secs(in.StartSec), "-t", secs(in.DurationSec), "-i", in.URL)
	}
	args = append(args,
		"-filter_complex", clipFilter(job, assPath),
		"-filter_complex_threads", "1",
		"-map", "[vo]", "-map", "[ao]",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p",
		"-r", strconv.Itoa(clipFPS), "-g", strconv.Itoa(2*clipFPS),
		"-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
		"-threads", strconv.Itoa(threads),
		"-movflags", "+faststart",
		"-progress", "pipe:1", "-nostats",
		out)
	return args
}

// clipFilter is the filter graph: [vo] and [ao] out.
func clipFilter(job ClipJob, assPath string) string {
	var b strings.Builder
	for i, in := range job.Inputs {
		b.WriteString(frameChain(job, i))
		fmt.Fprintf(&b, ",fps=%d,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v%d];", clipFPS, i)
		fade := min(0.05, in.DurationSec/4)
		fmt.Fprintf(&b, "[%d:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,"+
			"afade=t=in:d=%s,afade=t=out:st=%s:d=%s[a%d];", i, secs(fade), secs(max(in.DurationSec-fade, 0)), secs(fade), i)
	}
	for i := range job.Inputs {
		fmt.Fprintf(&b, "[v%d][a%d]", i, i)
	}
	fmt.Fprintf(&b, "concat=n=%d:v=1:a=1[vc][ac];", len(job.Inputs))
	if assPath != "" {
		b.WriteString("[vc]ass=filename=" + filterPath(assPath) + "[vo];")
	} else {
		b.WriteString("[vc]null[vo];")
	}
	b.WriteString("[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]")
	return b.String()
}

/* frameChain is input i's video fitted into the frame, its chain left open for clipFilter to
 * finish (fps, format, label). */
func frameChain(job ClipJob, i int) string {
	w, h := job.Width, job.Height
	src := fmt.Sprintf("[%d:v:0]", i)
	// The largest part of the picture with the frame's shape: a crop before any scale, so
	// nothing is scaled up only to be cut away.
	crop := func(x string) string {
		return fmt.Sprintf("crop='min(iw,ih*%d/%d)':'min(ih,iw*%d/%d)':%s:(ih-oh)/2", w, h, h, w, x)
	}
	if w > h { // 16:9: always the whole picture, letterboxed if it is not 16:9 itself
		return src + fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black", w, h, w, h)
	}
	switch job.Framing {
	case "center":
		return src + crop("(iw-ow)/2") + fmt.Sprintf(",scale=%d:%d", w, h)
	case "left":
		return src + crop("0") + fmt.Sprintf(",scale=%d:%d", w, h)
	case "right":
		return src + crop("iw-ow") + fmt.Sprintf(",scale=%d:%d", w, h)
	}
	// fit: the whole picture over a blurred, darkened copy filling the frame. The copy is
	// blurred small (a sixth of the frame), which is cheap and looks the same.
	sw, sh := w/6/2*2, h/6/2*2
	return fmt.Sprintf("%ssplit=2[bg%d][fg%d];[bg%d]%s,scale=%d:%d,boxblur=6:2,scale=%d:%d,eq=brightness=-0.08[bb%d];"+
		"[fg%d]scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2[ff%d];[bb%d][ff%d]overlay=(W-w)/2:(H-h)/2",
		src, i, i, i, crop("(iw-ow)/2"), sw, sh, w, h, i, i, w, h, i, i, i)
}

// filterPath is a path quoted for a filter option: our own paths, escaped anyway.
func filterPath(p string) string {
	return "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
}

// secs is seconds for ffmpeg, to the millisecond.
func secs(s float64) string { return strconv.FormatFloat(s, 'f', 3, 64) }

// probeDurationMs is a file's length.
func probeDurationMs(ctx context.Context, path string) (int64, error) {
	probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1", path).Output() // #nosec G204 -- our own path
	if err != nil {
		return 0, fmt.Errorf("ffprobe: %w", err)
	}
	secs, err := strconv.ParseFloat(strings.TrimSpace(string(probe)), 64)
	if err != nil {
		return 0, fmt.Errorf("ffprobe duration %q: %w", probe, err)
	}
	return int64(secs * 1000), nil
}

// ioniceWorks is whether the idle I/O class can be set here (a container may refuse it).
func ioniceWorks(ctx context.Context) bool {
	return exec.CommandContext(ctx, "ionice", "-c", "3", "true").Run() == nil
}
