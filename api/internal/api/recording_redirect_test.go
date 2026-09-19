package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/media"
)

/* A storage backend that knows about exactly one key.
 *
 * Only Stat and PresignedGetURL are reachable from redirectRecordingObject; the
 * rest of media.Store is here to satisfy the interface and panics if it is ever
 * called, so a future change that starts reading bytes on this path fails
 * loudly rather than passing a test that no longer means what it says.
 */
type oneKeyStore struct{ key string }

func (s oneKeyStore) Stat(_ context.Context, key string) (int64, error) {
	if key == s.key {
		return 1024, nil
	}
	return 0, media.ErrNotFound
}

func (s oneKeyStore) PresignedGetURL(_ context.Context, key, _, _ string, _ bool, _ time.Duration) (string, error) {
	return "https://origin.example.com/" + key + "?signed=1", nil
}

func (s oneKeyStore) PresignedURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://origin.example.com/" + key, nil
}

func (oneKeyStore) Append(context.Context, string, io.Reader) (int64, error) { panic("not used") }
func (oneKeyStore) Open(context.Context, string) (io.ReadSeekCloser, int64, error) {
	panic("not used")
}
func (oneKeyStore) Delete(context.Context, string) error                      { panic("not used") }
func (oneKeyStore) DeletePrefix(context.Context, string) error                { panic("not used") }
func (oneKeyStore) Finalize(context.Context, string) error                    { panic("not used") }
func (oneKeyStore) Describe() string                                          { return "one-key" }
func (oneKeyStore) FinalizeWithProgress(context.Context, string, func(int)) error {
	panic("not used")
}

// cdnHolding is a stand-in CDN that serves the keys it was given and 404s the
// rest, which is the whole behaviour under test.
func cdnHolding(t *testing.T, keys ...string) *httptest.Server {
	t.Helper()
	held := map[string]bool{}
	for _, k := range keys {
		held["/"+k] = true
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !held[r.URL.Path] {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	return ts
}

func redirectTo(t *testing.T, s *Server, key string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	if !s.redirectRecordingObject(rec, req, key, "talk.mp4", "video/mp4", true) {
		return 0, ""
	}
	return rec.Code, rec.Header().Get("Location")
}

// The ordinary case, and the reason the CDN is preferred at all: Cloudflare
// serves the bytes and the origin is never touched.
func TestRecordingRedirectPrefersTheCDNWhenItHasTheFile(t *testing.T) {
	const key = "f4/10/f410b5fd.mp4"
	cdn := cdnHolding(t, key)
	s := &Server{
		cfg:        config.Config{RecordingsCDNBaseURL: cdn.URL},
		recordings: oneKeyStore{key: key},
		log:        slog.New(slog.DiscardHandler),
	}

	code, loc := redirectTo(t, s, key)
	if code != http.StatusTemporaryRedirect || loc != cdn.URL+"/"+key {
		t.Fatalf("redirected to %q (%d), want the CDN copy", loc, code)
	}
}

/* The bucket-switch case. The recording is in the storage the API can reach but
 * not on the CDN, which is what changing buckets without moving the objects
 * looks like from here. Before this, the viewer was sent to the CDN anyway and
 * got its 404 page.
 */
func TestRecordingRedirectFallsBackToTheOriginWhenTheCDNIsMissingTheFile(t *testing.T) {
	const key = "f4/10/f410b5fd.mp4"
	cdn := cdnHolding(t) // holds nothing
	s := &Server{
		cfg:        config.Config{RecordingsCDNBaseURL: cdn.URL},
		recordings: oneKeyStore{key: key},
		log:        slog.New(slog.DiscardHandler),
	}

	code, loc := redirectTo(t, s, key)
	if code != http.StatusTemporaryRedirect {
		t.Fatalf("no redirect written (%d), want a fallback to the origin", code)
	}
	if loc != "https://origin.example.com/"+key+"?signed=1" {
		t.Fatalf("redirected to %q, want the presigned origin copy", loc)
	}
}

/* Gone everywhere. The caller has to be told so it can answer in our own words;
 * signing a URL for a key nothing is stored under would just move the dead end
 * to another hostname.
 */
func TestRecordingRedirectRefusesWhenTheFileIsNowhere(t *testing.T) {
	cdn := cdnHolding(t)
	s := &Server{
		cfg:        config.Config{RecordingsCDNBaseURL: cdn.URL},
		recordings: oneKeyStore{key: "something/else.mp4"},
		log:        slog.New(slog.DiscardHandler),
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	if s.redirectRecordingObject(rec, req, "f4/10/gone.mp4", "talk.mp4", "video/mp4", true) {
		t.Fatalf("redirected to %q, want the caller to report a missing file",
			rec.Header().Get("Location"))
	}
}

// No CDN configured is the single-origin deployment, and it still has to work.
func TestRecordingRedirectUsesTheOriginWhenNoCDNIsConfigured(t *testing.T) {
	const key = "f4/10/f410b5fd.mp4"
	s := &Server{
		cfg:        config.Config{},
		recordings: oneKeyStore{key: key},
		log:        slog.New(slog.DiscardHandler),
	}

	code, loc := redirectTo(t, s, key)
	if code != http.StatusTemporaryRedirect || loc != "https://origin.example.com/"+key+"?signed=1" {
		t.Fatalf("redirected to %q (%d), want the presigned origin copy", loc, code)
	}
}
