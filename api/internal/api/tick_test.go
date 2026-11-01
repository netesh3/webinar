package api_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

const testTickSecret = "tick-secret-tick-secret-tick-secret-0001"

func withTickSecret(c *config.Config) { c.TickSecret = testTickSecret }

// tick calls POST /api/internal/tick with the given secret and returns status and body.
func tick(t *testing.T, h *harness, secret string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.srv.URL+"/api/internal/tick", nil)
	if err != nil {
		t.Fatal(err)
	}
	if secret != "" {
		req.Header.Set("X-Tick-Secret", secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(body)
}

// Without TICK_SECRET the route does not exist: an always-on deployment has no use for it.
func TestTickNotMountedWithoutSecret(t *testing.T) {
	h := newHarness(t)
	if code, _ := tick(t, h, "anything"); code != http.StatusNotFound {
		t.Errorf("tick without TICK_SECRET = %d, want 404", code)
	}
}

// Public endpoint, so the secret is the whole of its protection.
func TestTickRefusesWrongSecret(t *testing.T) {
	h := newHarness(t, withTickSecret)
	for _, s := range []string{"", "wrong", testTickSecret + "x"} {
		if code, _ := tick(t, h, s); code != http.StatusUnauthorized {
			t.Errorf("tick with secret %q = %d, want 401", s, code)
		}
	}
}

/* The point of the endpoint: a reminder that is due goes out on a tick, with no other
 * request and no in-process ticker (the harness never starts one). Then a second runner
 * holding the lease makes the tick a no-op rather than a second send. */
func TestTickSendsDueReminderAndRespectsLease(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), withTickSecret)
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReminder, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"name"},
	})
	wb := remindersWebinar(t, h, "Ticked", true)
	registerOptedIn(t, h, wb.ID)
	ctx := context.Background()

	// Another runner holds the sweep: this tick must do nothing.
	release, ok, err := h.store.TryLease(ctx, "sweep", time.Minute)
	if err != nil || !ok {
		t.Fatalf("take lease: ok=%v err=%v", ok, err)
	}
	// Both reminders (24h, 1h) become due; the lease has to hold them back.
	makeDue(t, h, wb.ID)
	if code, body := tick(t, h, testTickSecret); code != http.StatusOK || !strings.Contains(body, `"busy"`) {
		t.Fatalf("tick under a held lease = %d %s, want 200 busy", code, body)
	}
	if n := len(g.sent()); n != 0 {
		t.Fatalf("%d sends while another runner held the lease", n)
	}

	release()
	if code, body := tick(t, h, testTickSecret); code != http.StatusOK || !strings.Contains(body, `"ran"`) {
		t.Fatalf("tick = %d %s, want 200 ran", code, body)
	}
	if n := len(g.sent()); n != 2 {
		t.Fatalf("%d sends after the tick, want the two due reminders", n)
	}
	// And once only: the next tick finds nothing owed.
	tick(t, h, testTickSecret)
	if n := len(g.sent()); n != 2 {
		t.Errorf("%d sends after a second tick, want still 2", n)
	}
}

// A lease is exclusive until released or expired, and release only drops the holder's own.
func TestLeaseExclusive(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	rel, ok, err := h.store.TryLease(ctx, "probe", time.Minute)
	if err != nil || !ok {
		t.Fatalf("first take: ok=%v err=%v", ok, err)
	}
	if _, ok, _ := h.store.TryLease(ctx, "probe", time.Minute); ok {
		t.Fatal("second take succeeded while the first was held")
	}
	rel()
	if _, ok, _ := h.store.TryLease(ctx, "probe", 50*time.Millisecond); !ok {
		t.Fatal("take after release failed")
	}
	time.Sleep(120 * time.Millisecond)
	if _, ok, _ := h.store.TryLease(ctx, "probe", time.Minute); !ok {
		t.Fatal("take after expiry failed: a crashed holder would block the sweep for ever")
	}
}

/* The daily token check: a token Meta says is dead is marked for Reconnect before any
 * send fails, and each host is checked once a day however often the tick runs. */
func TestTickChecksWhatsAppTokenDaily(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), withTickSecret)
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)

	me := func() *types.WhatsAppLink {
		t.Helper()
		_, raw := h.do(http.MethodGet, "/api/auth/me", nil)
		var a types.Account
		h.decode(raw, &a)
		return a.WhatsApp
	}

	// Healthy: checked once, nothing flagged, and a second tick does not ask again.
	for i := 0; i < 2; i++ {
		if code, body := tick(t, h, testTickSecret); code != http.StatusOK {
			t.Fatalf("tick %d: %d %s", i, code, body)
		}
	}
	g.mu.Lock()
	calls := g.debugCalls
	g.mu.Unlock()
	if calls != 1 {
		t.Errorf("debug_token calls = %d, want 1 (daily, not per tick)", calls)
	}
	if w := me(); w == nil || w.NeedsReconnect || w.TokenExpiresAt != "" {
		t.Fatalf("healthy token: %+v", w)
	}

	// Reconnecting resets the schedule; this time Meta says the token is dead.
	g.tokenHealth(map[string]any{"is_valid": false, "error": map[string]any{
		"code": 190, "subcode": 458, "message": "The user has not authorized application.",
	}})
	connectWhatsApp(t, h)
	tick(t, h, testTickSecret)
	if w := me(); w == nil || !w.NeedsReconnect {
		t.Fatalf("dead token not flagged: %+v", w)
	}

	// An expiring token has its date recorded, so the account can show it.
	g.tokenHealth(map[string]any{"is_valid": true, "expires_at": time.Now().Add(5 * 24 * time.Hour).Unix()})
	connectWhatsApp(t, h)
	tick(t, h, testTickSecret)
	if w := me(); w == nil || w.NeedsReconnect || w.TokenExpiresAt == "" {
		t.Errorf("expiring token: %+v, want an expiry date and no reconnect", w)
	}
}

/* A pass slower than the server's write timeout still gets its answer written, and the
 * pass stops at the tick's budget (1 Nov 2026). The server here has a 200 ms write timeout
 * standing in for cmd/server's 60 s; before the fix the 90 s lane outlived it, the answer
 * was never written, and Cloud Run read the broken connection as a failed instance. */
func TestTickAnswersPastWriteTimeoutWithinBudget(t *testing.T) {
	h := newHarness(t, withTickSecret)
	defer api.SetTickRequestBudget(700 * time.Millisecond)()
	stopped := make(chan time.Duration, 1)
	api.SetMaintenanceHook(h.server, func(ctx context.Context) {
		start := time.Now()
		<-ctx.Done()
		stopped <- time.Since(start)
	})
	srv := httptest.NewUnstartedServer(h.handler)
	srv.Config.WriteTimeout = 200 * time.Millisecond
	srv.Start()
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/internal/tick", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Tick-Secret", testTickSecret)
	start := time.Now()
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("tick past the write timeout: %v (the answer was never written)", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(body), `"ran"`) {
		t.Fatalf("tick = %d %s, want 200 ran", res.StatusCode, body)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Errorf("tick took %v with a 700 ms budget", took)
	}
	select {
	case d := <-stopped:
		if d > 2*time.Second {
			t.Errorf("the slow job ran %v; the tick's budget should have stopped it", d)
		}
	default:
		t.Error("the slow job was never stopped")
	}
}
