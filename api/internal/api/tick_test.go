package api_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

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
		Kind: types.NotifyWhatsAppReminder1h, Template: testTemplateUtility,
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
	/* The reminder becomes due a minute ago: "now" by this process's clock can still be
	 * the future by the database's, which is the clock the sweep reads. */
	if err := h.crm.RescheduleWhatsAppReminders(ctx, wb.ID, time.Now().Add(59*time.Minute)); err != nil {
		t.Fatalf("reschedule: %v", err)
	}
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
	if n := len(g.sent()); n != 1 {
		t.Fatalf("%d sends after the tick, want the one due reminder", n)
	}
	// And once only: the next tick finds nothing owed.
	tick(t, h, testTickSecret)
	if n := len(g.sent()); n != 1 {
		t.Errorf("%d sends after a second tick, want still 1", n)
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
