package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The maintenance banner: off by default, an admin turns it on with a message (or the default)
 * and off again, anybody reads it, and nobody else can set it. */
func TestSiteBanner(t *testing.T) {
	h := newHarness(t)

	read := func() types.SiteBanner {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/site-banner", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET /api/site-banner: %d %s", res.StatusCode, raw)
		}
		var b types.SiteBanner
		h.decode(raw, &b)
		return b
	}
	if b := read(); b.Enabled {
		t.Fatalf("banner on by default: %+v", b)
	}

	h.signup("Plain Host", "plain-host@test.dev", true)
	if res, _ := h.do(http.MethodPut, "/api/admin/site-banner", types.SetSiteBannerRequest{Enabled: true, Message: "x"}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin sets the banner: status %d, want 403", res.StatusCode)
	}

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodPut, "/api/admin/site-banner", types.SetSiteBannerRequest{Enabled: true, Message: "  Back by 6 pm IST.  "})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin sets the banner: %d %s", res.StatusCode, raw)
	}
	if b := read(); !b.Enabled || b.Message != "Back by 6 pm IST." || b.UpdatedAt == "" {
		t.Fatalf("after set: %+v", b)
	}

	// No message: the default.
	if res, raw := h.do(http.MethodPut, "/api/admin/site-banner", types.SetSiteBannerRequest{Enabled: true}); res.StatusCode != http.StatusOK {
		t.Fatalf("set without a message: %d %s", res.StatusCode, raw)
	}
	if b := read(); b.Message != types.SiteBannerDefaultMessage {
		t.Fatalf("empty message read as %q, want the default", b.Message)
	}

	long := make([]byte, types.SiteBannerMaxRunes+1)
	for i := range long {
		long[i] = 'a'
	}
	if res, _ := h.do(http.MethodPut, "/api/admin/site-banner", types.SetSiteBannerRequest{Enabled: true, Message: string(long)}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("over-long message: status %d, want 422", res.StatusCode)
	}

	if res, raw := h.do(http.MethodPut, "/api/admin/site-banner", types.SetSiteBannerRequest{Enabled: false}); res.StatusCode != http.StatusOK {
		t.Fatalf("admin clears the banner: %d %s", res.StatusCode, raw)
	}
	if b := read(); b.Enabled {
		t.Fatalf("still on after clearing: %+v", b)
	}
}
