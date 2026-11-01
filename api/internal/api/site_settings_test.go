package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The Downloads page switch: hidden by default, read by anyone through /api/config, and set
 * only by an admin, whose change shows in /api/config straight away. */
func TestSiteSettingsDownloadsVisible(t *testing.T) {
	h := newHarness(t)

	visible := func() bool {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/config", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET /api/config: %d %s", res.StatusCode, raw)
		}
		var c types.AppConfig
		h.decode(raw, &c)
		return c.DownloadsVisible
	}
	if visible() {
		t.Fatal("downloads visible by default, want hidden")
	}

	// Signed out: no admin read, no admin write.
	if res, _ := h.do(http.MethodPut, "/api/admin/site-settings", types.SetSiteSettingsRequest{DownloadsVisible: true}); res.StatusCode != http.StatusUnauthorized && res.StatusCode != http.StatusForbidden {
		t.Fatalf("anonymous sets site settings: status %d, want 401 or 403", res.StatusCode)
	}

	h.signup("Plain Host", "plain-host@test.dev", true)
	if res, _ := h.do(http.MethodGet, "/api/admin/site-settings", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin reads site settings: status %d, want 403", res.StatusCode)
	}
	if res, _ := h.do(http.MethodPut, "/api/admin/site-settings", types.SetSiteSettingsRequest{DownloadsVisible: true}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin sets site settings: status %d, want 403", res.StatusCode)
	}
	if visible() {
		t.Fatal("a refused write changed the switch")
	}

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/site-settings", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin reads site settings: %d %s", res.StatusCode, raw)
	}
	var got types.SiteSettings
	h.decode(raw, &got)
	if got.DownloadsVisible {
		t.Fatalf("admin read before any write: %+v", got)
	}

	res, raw = h.do(http.MethodPut, "/api/admin/site-settings", types.SetSiteSettingsRequest{DownloadsVisible: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin shows downloads: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &got)
	if !got.DownloadsVisible || got.UpdatedAt == "" {
		t.Fatalf("after show: %+v", got)
	}
	if !visible() {
		t.Fatal("/api/config still hidden after the admin turned downloads on")
	}

	if res, raw := h.do(http.MethodPut, "/api/admin/site-settings", types.SetSiteSettingsRequest{DownloadsVisible: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("admin hides downloads: %d %s", res.StatusCode, raw)
	}
	if visible() {
		t.Fatal("/api/config still visible after the admin hid downloads")
	}
}
