package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
)

// The goroutine dump is for admins, and only when DEBUG_GOROUTINES turned it on.
func TestDebugGoroutinesIsAdminOnlyAndOffByDefault(t *testing.T) {
	const path = "/api/admin/debug/goroutines"
	ctx := context.Background()

	off := newHarness(t)
	off.signup("Off Admin", "debug-off@test.dev", true)
	if _, _, err := off.store.PromoteAdmins(ctx, []string{"debug-off@test.dev"}); err != nil {
		t.Fatal(err)
	}
	off.login("debug-off@test.dev")
	if res, _ := off.do(http.MethodGet, path, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("switched off: status %d, want 404", res.StatusCode)
	}

	on := newHarness(t, func(c *config.Config) { c.DebugGoroutines = true })
	on.signup("Plain Host", "debug-host@test.dev", true)
	if res, _ := on.do(http.MethodGet, path, nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin: status %d, want 403", res.StatusCode)
	}
	on.logout()
	if res, _ := on.do(http.MethodGet, path, nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out: status %d, want 401", res.StatusCode)
	}
	on.signup("On Admin", "debug-on@test.dev", true)
	if _, _, err := on.store.PromoteAdmins(ctx, []string{"debug-on@test.dev"}); err != nil {
		t.Fatal(err)
	}
	on.login("debug-on@test.dev")
	res, raw := on.do(http.MethodGet, path, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin: status %d %s", res.StatusCode, raw)
	}
	if body := string(raw); !strings.HasPrefix(body, "goroutines: ") || !strings.Contains(body, "goroutine profile: total") {
		t.Fatalf("unexpected dump:\n%.400s", body)
	}
}
