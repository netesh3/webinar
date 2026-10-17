package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/types"
)

/* A maintenance job that will not finish cannot hold a reminder back: the two lanes run
 * side by side, and the due reminders go out while the maintenance lane is still stuck.
 * The tick itself answers once both lanes have stopped. */
func TestSlowMaintenanceDoesNotDelayReminders(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL), withTickSecret)
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReminder, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"name"},
	})
	wb := remindersWebinar(t, h, "Two lanes", true)
	registerOptedIn(t, h, wb.ID)

	stuck := make(chan struct{})
	entered := make(chan struct{}, 1)
	api.SetMaintenanceHook(h.server, func(ctx context.Context) {
		entered <- struct{}{}
		select {
		case <-stuck:
		case <-ctx.Done():
		}
	})
	makeDue(t, h, wb.ID)

	done := make(chan string, 1)
	go func() {
		_, body := tick(t, h, testTickSecret)
		done <- body
	}()

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the maintenance lane never started")
	}
	deadline := time.Now().Add(10 * time.Second)
	for len(g.sent()) < 2 {
		if time.Now().After(deadline) {
			close(stuck)
			t.Fatalf("%d sends while maintenance was stuck, want the two due reminders", len(g.sent()))
		}
		time.Sleep(20 * time.Millisecond)
	}
	select {
	case body := <-done:
		t.Fatalf("tick answered (%s) before the maintenance lane stopped", body)
	default:
	}

	close(stuck)
	select {
	case body := <-done:
		if !strings.Contains(body, `"ran"`) {
			t.Errorf("tick = %s, want ran", body)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("tick did not answer after maintenance was released")
	}
	if res, _ := h.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusOK {
		t.Errorf("server unhealthy after the tick: %d", res.StatusCode)
	}
}
