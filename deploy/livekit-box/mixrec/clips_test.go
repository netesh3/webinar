package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const clipID = "2d8f3c1e-2a4d-4e5f-8a9b-0c1d2e3f4a5b"

type goldenJob struct {
	name string
	job  ClipJob
	ass  string
}

func goldenJobs() []goldenJob {
	one := []ClipInput{{URL: "https://s3.example/rec/a.mp4?sig=1", StartSec: 125.5, DurationSec: 42.25}}
	reel := []ClipInput{
		{URL: "https://s3.example/rec/a.mp4?sig=1", StartSec: 10, DurationSec: 12},
		{URL: "https://s3.example/rec/b.mp4?sig=2", StartSec: 300.125, DurationSec: 15.5},
	}
	return []goldenJob{
		{"vertical fit with captions", ClipJob{ID: clipID, Format: "9x16", Width: 1080, Height: 1920, Framing: "fit", Inputs: one}, "/recordings/.clips/x.ass"},
		{"vertical right, reel, no captions", ClipJob{ID: clipID, Format: "9x16", Width: 1080, Height: 1920, Framing: "right", Inputs: reel}, ""},
		{"square centre", ClipJob{ID: clipID, Format: "1x1", Width: 1080, Height: 1080, Framing: "center", Inputs: one}, "/recordings/.clips/x.ass"},
		{"wide", ClipJob{ID: clipID, Format: "16x9", Width: 1920, Height: 1080, Framing: "fit", Inputs: one}, ""},
	}
}

// The command lines, whole: a change to any of them is a change to every clip made.
var goldenCommands = map[string]string{
	"vertical fit with captions": `nice
-n
19
ionice
-c
3
ffmpeg
-hide_banner
-nostdin
-loglevel
error
-y
-reconnect
1
-reconnect_on_network_error
1
-reconnect_delay_max
10
-ss
125.500
-t
42.250
-i
https://s3.example/rec/a.mp4?sig=1
-filter_complex
[0:v:0]split=2[bg0][fg0];[bg0]crop='min(iw,ih*1080/1920)':'min(ih,iw*1920/1080)':(iw-ow)/2:(ih-oh)/2,scale=180:320,boxblur=6:2,scale=1080:1920,eq=brightness=-0.08[bb0];[fg0]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[ff0];[bb0][ff0]overlay=(W-w)/2:(H-h)/2,fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v0];[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:d=0.050,afade=t=out:st=42.200:d=0.050[a0];[v0][a0]concat=n=1:v=1:a=1[vc][ac];[vc]ass=filename='/recordings/.clips/x.ass'[vo];[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]
-filter_complex_threads
1
-map
[vo]
-map
[ao]
-c:v
libx264
-preset
veryfast
-crf
21
-profile:v
high
-pix_fmt
yuv420p
-r
30
-g
60
-c:a
aac
-b:a
160k
-ar
48000
-ac
2
-threads
2
-movflags
+faststart
-progress
pipe:1
-nostats
/recordings/.clips/out.mp4`,
	"vertical right, reel, no captions": `nice
-n
19
ionice
-c
3
ffmpeg
-hide_banner
-nostdin
-loglevel
error
-y
-reconnect
1
-reconnect_on_network_error
1
-reconnect_delay_max
10
-ss
10.000
-t
12.000
-i
https://s3.example/rec/a.mp4?sig=1
-reconnect
1
-reconnect_on_network_error
1
-reconnect_delay_max
10
-ss
300.125
-t
15.500
-i
https://s3.example/rec/b.mp4?sig=2
-filter_complex
[0:v:0]crop='min(iw,ih*1080/1920)':'min(ih,iw*1920/1080)':iw-ow:(ih-oh)/2,scale=1080:1920,fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v0];[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:d=0.050,afade=t=out:st=11.950:d=0.050[a0];[1:v:0]crop='min(iw,ih*1080/1920)':'min(ih,iw*1920/1080)':iw-ow:(ih-oh)/2,scale=1080:1920,fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v1];[1:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:d=0.050,afade=t=out:st=15.450:d=0.050[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac];[vc]null[vo];[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]
-filter_complex_threads
1
-map
[vo]
-map
[ao]
-c:v
libx264
-preset
veryfast
-crf
21
-profile:v
high
-pix_fmt
yuv420p
-r
30
-g
60
-c:a
aac
-b:a
160k
-ar
48000
-ac
2
-threads
2
-movflags
+faststart
-progress
pipe:1
-nostats
/recordings/.clips/out.mp4`,
	"square centre": `nice
-n
19
ionice
-c
3
ffmpeg
-hide_banner
-nostdin
-loglevel
error
-y
-reconnect
1
-reconnect_on_network_error
1
-reconnect_delay_max
10
-ss
125.500
-t
42.250
-i
https://s3.example/rec/a.mp4?sig=1
-filter_complex
[0:v:0]crop='min(iw,ih*1080/1080)':'min(ih,iw*1080/1080)':(iw-ow)/2:(ih-oh)/2,scale=1080:1080,fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v0];[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:d=0.050,afade=t=out:st=42.200:d=0.050[a0];[v0][a0]concat=n=1:v=1:a=1[vc][ac];[vc]ass=filename='/recordings/.clips/x.ass'[vo];[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]
-filter_complex_threads
1
-map
[vo]
-map
[ao]
-c:v
libx264
-preset
veryfast
-crf
21
-profile:v
high
-pix_fmt
yuv420p
-r
30
-g
60
-c:a
aac
-b:a
160k
-ar
48000
-ac
2
-threads
2
-movflags
+faststart
-progress
pipe:1
-nostats
/recordings/.clips/out.mp4`,
	"wide": `nice
-n
19
ionice
-c
3
ffmpeg
-hide_banner
-nostdin
-loglevel
error
-y
-reconnect
1
-reconnect_on_network_error
1
-reconnect_delay_max
10
-ss
125.500
-t
42.250
-i
https://s3.example/rec/a.mp4?sig=1
-filter_complex
[0:v:0]scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v0];[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:d=0.050,afade=t=out:st=42.200:d=0.050[a0];[v0][a0]concat=n=1:v=1:a=1[vc][ac];[vc]null[vo];[ac]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[ao]
-filter_complex_threads
1
-map
[vo]
-map
[ao]
-c:v
libx264
-preset
veryfast
-crf
21
-profile:v
high
-pix_fmt
yuv420p
-r
30
-g
60
-c:a
aac
-b:a
160k
-ar
48000
-ac
2
-threads
2
-movflags
+faststart
-progress
pipe:1
-nostats
/recordings/.clips/out.mp4`,
}

func TestClipCommandGolden(t *testing.T) {
	for _, g := range goldenJobs() {
		want, ok := goldenCommands[g.name]
		if !ok {
			t.Fatalf("no golden for %q", g.name)
		}
		got := strings.Join(ffmpegClips{Threads: 2, Ionice: true}.renderCommand(g.job, g.ass, "/recordings/.clips/out.mp4"), "\n")
		if got != want {
			t.Errorf("%s:\n%s\n\nwant\n%s", g.name, got, want)
		}
	}
}

func TestClipCommandWithoutIonice(t *testing.T) {
	argv := ffmpegClips{Threads: 1}.renderCommand(goldenJobs()[0].job, "", "/o.mp4")
	if strings.Join(argv[:4], " ") != "nice -n 19 ffmpeg" {
		t.Fatalf("argv = %v", argv[:4])
	}
	// A local file gets no HTTP options.
	job := goldenJobs()[3].job
	job.Inputs = []ClipInput{{URL: "/tmp/in.mp4", StartSec: 1, DurationSec: 2}}
	if strings.Contains(strings.Join(clipArgs(job, "", "/o.mp4", 1), " "), "reconnect") {
		t.Fatal("reconnect options on a local file")
	}
}

func TestReadProgress(t *testing.T) {
	var got []float64
	readProgress(strings.NewReader("frame=10\nout_time_us=1500000\nout_time_ms=2000000\nout_time=00:00:02\nprogress=continue\nout_time_us=N/A\n"),
		func(s float64) { got = append(got, s) })
	if len(got) != 2 || got[0] != 1.5 || got[1] != 2 {
		t.Fatalf("progress = %v", got)
	}
}

// ---------------------------------------------------------------- the loop

type fakeClipAPI struct {
	mu        sync.Mutex
	jobs      []*ClipJob
	stopAfter int // progress reports before answering stop
	stopWhy   string
	progress  int
	results   []ClipResult
	uploads   int
}

func (f *fakeClipAPI) ClaimClip(context.Context) (*ClipJob, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.jobs) == 0 {
		return nil, "live", nil
	}
	j := f.jobs[0]
	f.jobs = f.jobs[1:]
	return j, "", nil
}

func (f *fakeClipAPI) ClipProgress(context.Context, string, int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.progress++
	if f.stopWhy != "" && f.progress >= f.stopAfter {
		return f.stopWhy, nil
	}
	return "", nil
}

func (f *fakeClipAPI) ClipUploadURL(context.Context, string) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.uploads++
	return "https://upload.example/x", "video/mp4", nil
}

func (f *fakeClipAPI) ClipComplete(_ context.Context, _ string, res ClipResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results = append(f.results, res)
	return nil
}

// fakeRender writes a file, or blocks until cancelled when slow.
type fakeRender struct {
	slow bool
	err  error
	ass  string
}

func (r *fakeRender) Render(ctx context.Context, job ClipJob, assPath, out string, progress func(float64)) (int64, error) {
	if assPath != "" {
		raw, _ := os.ReadFile(assPath)
		r.ass = string(raw)
	}
	progress(1)
	if r.slow {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	if r.err != nil {
		return 0, r.err
	}
	return 4200, os.WriteFile(out, []byte("mp4"), 0o600)
}

type fakePut struct{ n int }

func (p *fakePut) Put(_ context.Context, _, _, path string) (int64, error) {
	p.n++
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestClipperMakesAJob(t *testing.T) {
	api := &fakeClipAPI{jobs: []*ClipJob{{ID: clipID, Format: "9x16", DurationSec: 10, Subtitles: "[Script Info]\n"}}}
	render := &fakeRender{}
	up := &fakePut{}
	dir := t.TempDir()
	c := NewClipper(ClipSettings{Dir: filepath.Join(dir, ".clips"), Beat: time.Hour}, api, render, up, nil, quietLog())
	if !c.Once(context.Background()) {
		t.Fatal("no job made")
	}
	if len(api.results) != 1 || api.results[0].SizeBytes != 3 || api.results[0].DurationMs != 4200 || up.n != 1 {
		t.Fatalf("results %+v, puts %d", api.results, up.n)
	}
	if render.ass != "[Script Info]\n" {
		t.Fatalf("captions file = %q", render.ass)
	}
	left, _ := os.ReadDir(filepath.Join(dir, ".clips"))
	if len(left) != 0 {
		t.Fatalf("scratch files left: %v", left)
	}
	// Nothing more: false, and nothing reported.
	if c.Once(context.Background()) {
		t.Fatal("a job from an empty queue")
	}
}

func TestClipperDropsAJobTheAPIStops(t *testing.T) {
	api := &fakeClipAPI{jobs: []*ClipJob{{ID: clipID, DurationSec: 10}}, stopAfter: 1, stopWhy: "live"}
	up := &fakePut{}
	c := NewClipper(ClipSettings{Dir: t.TempDir(), Beat: 10 * time.Millisecond}, api, &fakeRender{slow: true}, up, nil, quietLog())
	done := make(chan struct{})
	go func() { c.Once(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the render was not stopped")
	}
	if len(api.results) != 0 || up.n != 0 {
		t.Fatalf("a stopped job was reported: %+v, puts %d", api.results, up.n)
	}
}

func TestClipperReportsAFailure(t *testing.T) {
	api := &fakeClipAPI{jobs: []*ClipJob{{ID: clipID, DurationSec: 10}}}
	c := NewClipper(ClipSettings{Dir: t.TempDir(), Beat: time.Hour}, api, &fakeRender{err: errors.New("ffmpeg: exit 1: bad input")}, &fakePut{}, nil, quietLog())
	c.Once(context.Background())
	if len(api.results) != 1 || !strings.Contains(api.results[0].Error, "bad input") || !api.results[0].Retry {
		t.Fatalf("results = %+v", api.results)
	}
}

func TestClipperWaitsWhileRecording(t *testing.T) {
	api := &fakeClipAPI{jobs: []*ClipJob{{ID: clipID, DurationSec: 10}}}
	c := NewClipper(ClipSettings{Dir: t.TempDir(), Every: 5 * time.Millisecond, Beat: time.Hour}, api, &fakeRender{}, &fakePut{},
		func() bool { return true }, quietLog())
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	c.Run(ctx)
	if len(api.jobs) != 1 {
		t.Fatal("a job was claimed while a mix recording was in progress")
	}
}

// ---------------------------------------------------------------- a real render

/* TestClipRenderTiny renders a two-moment reel in each format from a generated source, when
 * ffmpeg is here, and checks the result: H.264 and AAC at the format's size, about as long
 * as the moments. Captions are burned in too when this ffmpeg has libass (the box's does). */
func TestClipRenderTiny(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("no ffmpeg")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp4")
	gen := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
		"-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-movflags", "+faststart", src)
	if out, err := gen.CombinedOutput(); err != nil {
		t.Skipf("cannot make a source here: %v %s", err, out)
	}
	filters, _ := exec.Command("ffmpeg", "-hide_banner", "-filters").Output()
	hasASS := strings.Contains(string(filters), " ass ")
	ass := ""
	if hasASS {
		ass = filepath.Join(dir, "c.ass")
		script := "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\n" +
			"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
			"Style: Caption,Inter,88,&H00FFFFFF,&H0000D7FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,3,2,90,90,620,1\n\n" +
			"[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
			"Dialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,{\\c&H00D7FF&}Hello{\\c&HFFFFFF&} world\n"
		if err := os.WriteFile(ass, []byte(script), 0o600); err != nil {
			t.Fatal(err)
		}
	} else {
		t.Log("this ffmpeg has no libass: rendering without captions")
	}
	inputs := []ClipInput{{URL: src, StartSec: 0.5, DurationSec: 1.5}, {URL: src, StartSec: 3, DurationSec: 2}}
	for _, f := range []struct {
		format, framing string
		w, h            int
	}{{"9x16", "fit", 1080, 1920}, {"1x1", "right", 1080, 1080}, {"16x9", "fit", 1920, 1080}} {
		out := filepath.Join(dir, f.format+".mp4")
		job := ClipJob{ID: clipID, Format: f.format, Width: f.w, Height: f.h, Framing: f.framing, Inputs: inputs, DurationSec: 3.5}
		ms, err := ffmpegClips{Threads: 2}.Render(context.Background(), job, ass, out, nil)
		if err != nil {
			t.Fatalf("%s: %v", f.format, err)
		}
		if ms < 3300 || ms > 3800 {
			t.Errorf("%s: %d ms, want about 3500", f.format, ms)
		}
		probe, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height",
			"-of", "csv=p=0", out).Output()
		if err != nil {
			t.Fatal(err)
		}
		got := strings.Fields(strings.ReplaceAll(string(probe), "\n", " "))
		want := []string{"h264," + strconv.Itoa(f.w) + "," + strconv.Itoa(f.h), "aac"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Errorf("%s: streams %v, want %v", f.format, got, want)
		}
	}
}
