package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* The WhatsApp rows follow the webinar through the Engage hooks.
 *
 * The webinar store retires and moves only EMAIL reminders now; the WhatsApp twins are the
 * CRM's, run when the webinar side calls OnRescheduled, OnRegistrationsDecided and OnEnded.
 * A hook that is not called, or is called with the wrong slug, would leave a reminder that
 * says "in an hour" three hours late, or one that goes to somebody the host declined —
 * each a message the host pays for and cannot take back. So each path is driven here
 * through the host's own HTTP action, not through the store.
 */
func TestWhatsAppRemindersFollowWebinar(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h,
		types.CRMReminder{Kind: types.NotifyWhatsAppReminder24h, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"name"}},
		types.CRMReminder{Kind: types.NotifyWhatsAppReminder1h, Template: testTemplateUtility,
			Language: "en_US", Params: []string{"name"}},
	)
	wb := remindersWebinar(t, h, "Follows its webinar", true)
	registerOptedIn(t, h, wb.ID)
	ctx := context.Background()

	waRow := func(kind types.NotificationKind) (delivery string, due time.Time) {
		t.Helper()
		err := h.store.Pool().QueryRow(ctx, `
			SELECT n.delivery, n.due_at FROM notifications n JOIN webinars w ON w.id = n.webinar_id
			 WHERE w.slug = $1 AND n.channel = 'whatsapp' AND n.kind = $2`, wb.ID, string(kind)).
			Scan(&delivery, &due)
		if err != nil {
			t.Fatalf("%s row: %v", kind, err)
		}
		return delivery, due
	}

	// Reschedule, the way a host does: the edit form's PATCH.
	moved := time.Now().Add(72 * time.Hour).UTC().Truncate(time.Second)
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, types.WebinarInput{
		Topic: wb.Topic, StartsAt: moved.Format(time.RFC3339), Duration: 45,
		Kind: types.KindLive, Status: types.StatusScheduled, RegistrationRequired: true,
		Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
		Options: types.WebinarOptions{WhatsAppReminders: true},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reschedule: status %d body %s", res.StatusCode, raw)
	}
	for kind, before := range map[types.NotificationKind]time.Duration{
		types.NotifyWhatsAppReminder24h: 24 * time.Hour,
		types.NotifyWhatsAppReminder1h:  time.Hour,
	} {
		delivery, due := waRow(kind)
		if want := moved.Add(-before); !due.Equal(want) || delivery != "pending" {
			t.Errorf("%s after reschedule: %s due %v, want pending due %v", kind, delivery, due, want)
		}
	}

	// End it: every WhatsApp reminder still owed is for a session that is over.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}
	for _, kind := range []types.NotificationKind{types.NotifyWhatsAppReminder24h, types.NotifyWhatsAppReminder1h} {
		if delivery, _ := waRow(kind); delivery != "skipped" {
			t.Errorf("%s after the webinar ended: %s, want skipped", kind, delivery)
		}
	}
}

/* A declined seat's WhatsApp confirmation is retired, not left waiting for an approval that
 * is never coming. The webinar side owns the decision; the CRM hears it and skips its row. */
func TestWhatsAppConfirmationSkippedOnDecline(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"name"},
	})
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Declined", "startsAt": time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339),
		"durationMin": 45, "status": "scheduled", "registrationRequired": true,
		"approval": "manual", "attendeeLimit": 100,
		"options": map[string]any{"whatsappReminders": true},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	registerOptedIn(t, h, wb.ID)

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/approvals",
		types.ApprovalsRequest{
			IDs:   []string{idOf(t, h, wb.ID, "thandi@example.com")},
			State: types.RegDeclined,
		})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("decline: status %d body %s", res.StatusCode, raw)
	}

	var delivery, reason string
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT n.delivery, coalesce(n.delivery_error,'') FROM notifications n
		  JOIN webinars w ON w.id = n.webinar_id
		 WHERE w.slug = $1 AND n.kind = 'wa_registration_confirmed'`, wb.ID).
		Scan(&delivery, &reason); err != nil {
		t.Fatalf("confirmation row: %v", err)
	}
	if delivery != "skipped" || reason != "registration declined" {
		t.Errorf("confirmation after decline: %s (%q), want skipped (registration declined)", delivery, reason)
	}
	if sends := g.sent(); len(sends) != 0 {
		t.Errorf("a declined registrant was messaged: %v", sends)
	}
}
