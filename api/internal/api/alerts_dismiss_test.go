package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// alerts reads the caller's bell.
func alerts(t *testing.T, h *harness) types.AlertsResponse {
	t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/alerts", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("alerts: status %d body %s", res.StatusCode, raw)
	}
	var out types.AlertsResponse
	h.decode(raw, &out)
	return out
}

func hasAlert(list []types.HostAlert, id string) bool {
	for _, a := range list {
		if a.ID == id {
			return true
		}
	}
	return false
}

// A host with n fresh approval alerts.
func hostWithAlerts(t *testing.T, h *harness, host, topic string, emails ...string) types.AlertsResponse {
	t.Helper()
	h.login(host)
	wb := manualWebinar(t, h, topic)
	for _, e := range emails {
		registerGuest(t, h, wb.ID, e)
	}
	h.login(host)
	got := alerts(t, h)
	if len(got.Alerts) < len(emails) {
		t.Fatalf("alerts = %d, want at least %d", len(got.Alerts), len(emails))
	}
	return got
}

/* Dismissing one notification removes it from the list and the badge, for good, and leaves
 * the others where they were. */
func TestDismissOneAlert(t *testing.T) {
	h := newHarness(t)
	before := hostWithAlerts(t, h, "neeraj@acme.dev", "Dismiss one", "a@test.dev", "b@test.dev")
	gone, kept := before.Alerts[0], before.Alerts[1]

	res, raw := h.do(http.MethodDelete, "/api/host/alerts/"+gone.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("dismiss: status %d body %s", res.StatusCode, raw)
	}
	var changed types.AlertsChangedResponse
	h.decode(raw, &changed)
	if changed.Changed != 1 || changed.Unread != before.Unread-1 {
		t.Errorf("dismiss reply = %+v, want changed 1, unread %d", changed, before.Unread-1)
	}

	// A refresh does not bring it back.
	after := alerts(t, h)
	if hasAlert(after.Alerts, gone.ID) {
		t.Error("a dismissed alert is still listed")
	}
	if !hasAlert(after.Alerts, kept.ID) {
		t.Error("dismissing one alert removed another")
	}
	if after.Unread != before.Unread-1 {
		t.Errorf("unread = %d, want %d", after.Unread, before.Unread-1)
	}

	// Twice is a 404, not a second decrement.
	res, _ = h.do(http.MethodDelete, "/api/host/alerts/"+gone.ID, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("second dismiss: status %d, want 404", res.StatusCode)
	}
}

// "Clear all" empties the panel and the badge.
func TestDismissAllAlerts(t *testing.T) {
	h := newHarness(t)
	hostWithAlerts(t, h, "neeraj@acme.dev", "Clear all", "a@test.dev", "b@test.dev")

	res, raw := h.do(http.MethodPost, "/api/host/alerts/dismiss-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("dismiss all: status %d body %s", res.StatusCode, raw)
	}
	var changed types.AlertsChangedResponse
	h.decode(raw, &changed)
	if changed.Changed < 2 || changed.Unread != 0 {
		t.Errorf("dismiss-all reply = %+v, want changed >= 2, unread 0", changed)
	}
	after := alerts(t, h)
	if len(after.Alerts) != 0 || after.Unread != 0 {
		t.Errorf("after clear all: %d alerts, %d unread, want none", len(after.Alerts), after.Unread)
	}
}

// "Mark all as read" keeps the rows and zeroes the badge.
func TestReadAllAlerts(t *testing.T) {
	h := newHarness(t)
	before := hostWithAlerts(t, h, "neeraj@acme.dev", "Read all", "a@test.dev", "b@test.dev")

	res, raw := h.do(http.MethodPost, "/api/host/alerts/read-all", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("read all: status %d body %s", res.StatusCode, raw)
	}
	var changed types.AlertsChangedResponse
	h.decode(raw, &changed)
	if changed.Unread != 0 || changed.Changed != before.Unread {
		t.Errorf("read-all reply = %+v, want changed %d, unread 0", changed, before.Unread)
	}
	after := alerts(t, h)
	if after.Unread != 0 {
		t.Errorf("unread = %d after read all, want 0", after.Unread)
	}
	if len(after.Alerts) != len(before.Alerts) {
		t.Errorf("read all changed the list: %d -> %d rows", len(before.Alerts), len(after.Alerts))
	}
	for _, a := range after.Alerts {
		if a.Unread {
			t.Errorf("alert %s still unread", a.ID)
		}
	}
}

/* One host cannot dismiss another's notification, one at a time or all at once. */
func TestOneHostCannotDismissAnotherHostsAlerts(t *testing.T) {
	h := newHarness(t)
	hers := hostWithAlerts(t, h, "lucia@cabify.com", "Lucia's queue", "hers@test.dev")
	target := hers.Alerts[0]

	h.login("neeraj@acme.dev")
	res, _ := h.do(http.MethodDelete, "/api/host/alerts/"+target.ID, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("dismissing another host's alert: status %d, want 404", res.StatusCode)
	}
	if res, raw := h.do(http.MethodPost, "/api/host/alerts/dismiss-all", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("dismiss all: status %d body %s", res.StatusCode, raw)
	}

	h.login("lucia@cabify.com")
	after := alerts(t, h)
	if !hasAlert(after.Alerts, target.ID) {
		t.Error("another host dismissed this host's alert")
	}
	if after.Unread != hers.Unread {
		t.Errorf("unread = %d, want %d", after.Unread, hers.Unread)
	}
}

// Alerts older than 90 days drop out of the list and the badge.
func TestOldAlertsExpireFromTheBell(t *testing.T) {
	h := newHarness(t)
	before := hostWithAlerts(t, h, "neeraj@acme.dev", "Old news", "a@test.dev", "b@test.dev")
	old := before.Alerts[0]

	if _, err := h.store.Pool().Exec(t.Context(),
		`UPDATE notifications SET created_at = now() - interval '91 days' WHERE id = $1`, old.ID); err != nil {
		t.Fatal(err)
	}
	after := alerts(t, h)
	if hasAlert(after.Alerts, old.ID) {
		t.Error("a 91-day-old alert is still listed")
	}
	if after.Unread != before.Unread-1 {
		t.Errorf("unread = %d, want %d", after.Unread, before.Unread-1)
	}
}
