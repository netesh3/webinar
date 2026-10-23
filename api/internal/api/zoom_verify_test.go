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

/* A new address registers unverified, and opening the email link is what
 * finishes the registration. That is also when Zoom is told about the person:
 * without it they have no personal Zoom link and the room refuses them.
 */

func TestZoomRegistrantAddedWhenEmailIsVerified(t *testing.T) {
	const meetingID = "2002"
	var pushed atomic.Int32
	zoomSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth/token":
			_, _ = w.Write([]byte(`{"access_token":"access","refresh_token":"refresh-1","expires_in":3600}`))
		case r.Method == http.MethodPost && r.URL.Path == "/meetings/"+meetingID+"/registrants":
			pushed.Add(1)
			_, _ = w.Write([]byte(`{"registrant_id":"zr-1","join_url":"https://zoom.us/w/2002?tk=personal"}`))
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
	host := h.signup("Zoom Host", "zoom-verify-host@test.dev", true)
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
		UserID: host.ID, ZoomUserID: "zhost", Email: "zoom-verify-host@test.dev", Refresh: blob,
	}); err != nil {
		t.Fatal(err)
	}

	wb := h.newWebinar("Zoom After Verify", nil)
	if err := h.store.SetWebinarZoom(context.Background(), wb.ID, zoom.VenueMeeting, meetingID, "https://zoom.us/s/host", ""); err != nil {
		t.Fatal(err)
	}

	h.logout()
	h.holdVerification = true
	held := h.postRegister(wb.ID, "new-zoom-guest@example.test", "New", "Guest", h.validAnswers(wb.ID))
	if held.State != types.RegUnverified {
		t.Fatalf("state = %q, want unverified before the link", held.State)
	}
	if n := pushed.Load(); n != 0 {
		t.Fatalf("Zoom told %d times before the address was verified", n)
	}

	reg := h.finishRegistration(wb.ID, "new-zoom-guest@example.test", held)
	h.server.WaitBackground()
	if n := pushed.Load(); n != 1 {
		t.Fatalf("Zoom told %d times after verification, want 1", n)
	}
	u, err := h.store.RegistrationZoomJoin(context.Background(), reg.ID)
	if err != nil || u != "https://zoom.us/w/2002?tk=personal" {
		t.Fatalf("zoom join = %q, %v; want the personal link", u, err)
	}
}
