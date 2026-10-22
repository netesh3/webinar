package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

/* Environment (mixrec.env, written by redeploy.sh from /opt/livekit/.env):
 *
 *   MIXREC_SECRET      shared with the API (its MIXREC_SECRET), 32+ characters
 *   MIXREC_API_URL     the API's base URL, default https://webinarliv.com
 *   MIXREC_LISTEN      default 127.0.0.1:7895 (Caddy proxies /mixrec/* here)
 *   MIXREC_RECORD_DIR  MediaMTX's record root as mounted here, default /recordings
 */

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	secret := env("MIXREC_SECRET", "")
	if len(secret) < 32 {
		log.Error("MIXREC_SECRET must be at least 32 characters")
		os.Exit(1)
	}
	apiURL := strings.TrimRight(env("MIXREC_API_URL", "https://webinarliv.com"), "/")

	rec := NewRecorder(Settings{RecordDir: env("MIXREC_RECORD_DIR", "/recordings")},
		&apiClient{base: apiURL, secret: secret, http: &http.Client{Timeout: 30 * time.Second}},
		ffmpegRemuxer{}, httpUploader{}, log)
	if err := rec.Load(); err != nil {
		log.Error("load state", "error", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go rec.Run(ctx, 2*time.Second)

	srv := &http.Server{
		Addr:              env("MIXREC_LISTEN", "127.0.0.1:7895"),
		Handler:           Handler(rec, secret),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	log.Info("mix recorder listening", "addr", srv.Addr, "api", apiURL)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("listen", "error", err)
		os.Exit(1)
	}
}

// Handler is the recorder's HTTP API. Caddy strips the /mixrec prefix.
func Handler(rec *Recorder, secret string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})
	job := func(op func(id, slug string) error) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			got := r.Header.Get("X-Mixrec-Secret")
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(secret)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			var body struct {
				RecordingID string `json:"recordingId"`
				Slug        string `json:"slug"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			if err := op(body.RecordingID, body.Slug); err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"ok"}`)
		}
	}
	mux.HandleFunc("POST /v1/start", job(rec.Start))
	mux.HandleFunc("POST /v1/stop", job(func(id, _ string) error { return rec.Stop(id) }))
	mux.HandleFunc("POST /v1/cancel", job(func(id, _ string) error { return rec.Cancel(id) }))
	return mux
}

// apiClient talks to the API's /api/internal/mix-recordings endpoints.
type apiClient struct {
	base   string
	secret string
	http   *http.Client
}

func (a *apiClient) post(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Mixrec-Secret", a.secret)
	res, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("%s: %d %s", path, res.StatusCode, strings.TrimSpace(string(msg)))
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

func (a *apiClient) UploadURL(ctx context.Context, id string) (string, string, error) {
	var out struct {
		URL         string `json:"url"`
		ContentType string `json:"contentType"`
	}
	if err := a.post(ctx, "/api/internal/mix-recordings/"+id+"/upload-url", struct{}{}, &out); err != nil {
		return "", "", err
	}
	if out.URL == "" {
		return "", "", errors.New("no upload url")
	}
	return out.URL, out.ContentType, nil
}

func (a *apiClient) Complete(ctx context.Context, id string, res Result) error {
	return a.post(ctx, "/api/internal/mix-recordings/"+id+"/complete", res, nil)
}

// maxPut is one S3 PUT's limit.
const maxPut = 5 << 30

type httpUploader struct{}

func (httpUploader) Put(ctx context.Context, url, contentType, path string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if info.Size() > maxPut {
		return 0, fmt.Errorf("recording is %d bytes, over the 5 GiB single-upload limit", info.Size())
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, f)
	if err != nil {
		return 0, err
	}
	req.ContentLength = info.Size()
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return 0, fmt.Errorf("put: %d %s", res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return info.Size(), nil
}

// ffmpegRemuxer joins the segments with ffmpeg's concat demuxer: a copy, never an encode.
type ffmpegRemuxer struct{}

func (ffmpegRemuxer) Remux(ctx context.Context, segments []string, out string) (int64, error) {
	list := out + ".txt"
	if err := os.WriteFile(list, []byte(concatList(segments)), 0o600); err != nil {
		return 0, err
	}
	defer os.Remove(list)
	cmd := exec.CommandContext(ctx, "nice", "-n", "10", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out) // #nosec G204 -- our own paths
	if msg, err := cmd.CombinedOutput(); err != nil {
		return 0, fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(string(msg)))
	}
	probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1", out).Output() // #nosec G204 -- our own path
	if err != nil {
		return 0, fmt.Errorf("ffprobe: %w", err)
	}
	secs, err := strconv.ParseFloat(strings.TrimSpace(string(probe)), 64)
	if err != nil {
		return 0, fmt.Errorf("ffprobe duration %q: %w", probe, err)
	}
	return int64(secs * 1000), nil
}

// concatList is an ffmpeg concat script. Paths are our own (RecordDir/rec/<slug>/<time>.mp4),
// quoted anyway.
func concatList(segments []string) string {
	var b strings.Builder
	for _, s := range segments {
		abs, err := filepath.Abs(s)
		if err != nil {
			abs = s
		}
		b.WriteString("file '" + strings.ReplaceAll(abs, "'", `'\''`) + "'\n")
	}
	return b.String()
}
