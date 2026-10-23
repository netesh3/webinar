package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* Deleting a webinar that runs on Zoom deletes the Zoom meeting too, so it does
 * not linger in the host's Zoom account (case H of the Zoom review test plan).
 */

func TestDeletingAZoomWebinarDeletesTheMeeting(t *testing.T) {
	const meetingID = "3003"
	var deleted atomic.Int32
	zoomSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth/token":
			_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh-1","expires_in":3600}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/meetings/"+meetingID:
			deleted.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(zoomSrv.Close)

	const tokenKey = "0123456789abcdef0123456789abcdef"
	h := newHarness(t, func(cfg *config.Config) {
		cfg.ZoomClientID = "cid"
		cfg.ZoomClientSecret = "sec"
		cfg.ZoomRedirectURL = "https://example.test/api/host/zoom/callback"
		cfg.ZoomTokenKey = tokenKey
		cfg.ZoomAPIURL = zoomSrv.URL
		cfg.ZoomOAuthURL = zoomSrv.URL
	})
	host := h.signup("Zoom Host", "zoom-delete-host@test.dev", true)
	grantFeature(t, h, host.ID, types.FeatureZoom)
	key, err := zoom.ParseKey(tokenKey)
	if err != nil {
		t.Fatal(err)
	}
	blob, err := zoom.Seal(key, "refresh-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.SaveZoomConnection(context.Background(), store.ZoomConnection{
		UserID: host.ID, ZoomUserID: "zhost", Email: "zoom-delete-host@test.dev", Refresh: blob,
	}); err != nil {
		t.Fatal(err)
	}

	// A webinar in this app only: nothing to delete in Zoom.
	plain := h.newWebinar("In the app", nil)
	res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+plain.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete app webinar: status %d body %s", res.StatusCode, raw)
	}
	if n := deleted.Load(); n != 0 {
		t.Fatalf("Zoom delete called %d times for a webinar not in Zoom", n)
	}

	wb := h.newWebinar("On Zoom", nil)
	if err := h.store.SetWebinarZoom(context.Background(), wb.ID, zoom.VenueMeeting, meetingID, "https://zoom.us/s/host", ""); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodDelete, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete zoom webinar: status %d body %s", res.StatusCode, raw)
	}
	if n := deleted.Load(); n != 1 {
		t.Fatalf("Zoom delete called %d times, want 1", n)
	}
}
