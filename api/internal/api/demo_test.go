package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The demo door.
 *
 * Off by default is the load-bearing behaviour: everything else here only runs
 * once DemoMode is explicitly turned on, the same as a real deployment would
 * have to opt in.
 */

func TestLaunchDemoOffByDefault(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodPost, "/api/demo/launch", types.DemoLaunchRequest{
		Name: "Priya Shah", Email: "priya@example.com",
	})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d body %s, want 404 — the door must not exist unless DemoMode is set", res.StatusCode, raw)
	}
}

func TestLaunchDemoHappyPath(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.DemoMode = true })

	res, raw := h.do(http.MethodPost, "/api/demo/launch", types.DemoLaunchRequest{
		Name: "Priya Shah", Email: "priya@example.com",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("status %d body %s, want 201", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)

	if wb.Status != types.StatusLive {
		t.Errorf("status = %q, want live — a demo has to be usable the instant it is launched", wb.Status)
	}
	if !wb.IsDemo {
		t.Error("IsDemo = false; a demo webinar must be flagged so it is never mistaken for a real one")
	}
	if !wb.GuestJoinAllowed {
		t.Error("GuestJoinAllowed = false; the whole point is a link anyone can open with just a name")
	}
	if wb.Host.Name != "Priya Shah" {
		t.Errorf("host name = %q, want the name that was launched with", wb.Host.Name)
	}

	// The session this call sets is what actually makes the caller the host —
	// nothing else in this app hands out hosting rights without one.
	res2, raw2 := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("host GET on the demo webinar: status %d body %s — the launch did not sign the caller in as its host", res2.StatusCode, raw2)
	}

	// And the link this is all for: a stranger, no account, no cookie, joining
	// on a name alone.
	res3, raw3 := h.guestJoin(wb.ID, "A Curious Stranger")
	if res3.StatusCode != http.StatusOK {
		t.Fatalf("guest join on the demo webinar: status %d body %s", res3.StatusCode, raw3)
	}
}

// A demo launch must never be a way to hand hosting rights to an account that
// did not already have them — including by "reusing" a real one that happens
// to share the email.
func TestLaunchDemoRefusesAnEmailAlreadyInUse(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.DemoMode = true })

	// Seeded by SeedDev — a real, ordinary account.
	const existing = "neeraj@acme.dev"

	res, raw := h.do(http.MethodPost, "/api/demo/launch", types.DemoLaunchRequest{
		Name: "Someone Else", Email: existing,
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status %d body %s, want 422 — an existing email must be refused, not silently reused", res.StatusCode, raw)
	}

	// And that account's own standing is completely unaffected by the attempt.
	h.login(existing)
	res2, raw2 := h.do(http.MethodGet, "/api/auth/me", nil)
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("status %d body %s", res2.StatusCode, raw2)
	}
	var acct types.Account
	h.decode(raw2, &acct)
	if acct.CanHost {
		t.Error("an existing non-host account gained CanHost from a refused demo-launch attempt on its email")
	}
}

func TestLaunchDemoValidatesNameAndEmail(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.DemoMode = true })

	res, raw := h.do(http.MethodPost, "/api/demo/launch", types.DemoLaunchRequest{
		Name: "", Email: "not-an-email",
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status %d body %s, want 422", res.StatusCode, raw)
	}
}

// A demo webinar past its two-hour window is read back as ended, lazily, the
// next time anybody loads it — see Store.expireDemo. Exercised directly
// against the store rather than by actually waiting two hours.
func TestDemoWebinarExpiresLazily(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.DemoMode = true })

	res, raw := h.do(http.MethodPost, "/api/demo/launch", types.DemoLaunchRequest{
		Name: "Priya Shah", Email: "priya@example.com",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)

	ctx := context.Background()
	if err := h.store.SetDemo(ctx, wb.ID, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("backdate expiry: %v", err)
	}

	again, err := h.store.WebinarBySlug(ctx, wb.ID)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if again.Status != types.StatusEnded {
		t.Errorf("status = %q, want ended — an expired demo must not stay joinable forever", again.Status)
	}
}
