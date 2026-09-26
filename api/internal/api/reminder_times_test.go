package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// reminderWebinar creates a scheduled webinar two days out with the given reminder times
// (nil omits the field) and WhatsApp switched on.
func reminderWebinar(t *testing.T, h *harness, reminders []int) (types.Webinar, time.Time) {
	t.Helper()
	starts := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	opts := map[string]any{"whatsappReminders": true, "emailReminders": true}
	if reminders != nil {
		opts["reminders"] = reminders
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
		"topic": "Timed", "startsAt": starts.Format(time.RFC3339), "durationMin": 45,
		"status": "scheduled", "registrationRequired": true, "approval": "automatic",
		"attendeeLimit": 100, "options": opts,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create webinar: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb, starts
}

// saveWebinar PATCHes the webinar the way the edit form does, with new times.
func saveWebinar(t *testing.T, h *harness, wb types.Webinar, starts time.Time, reminders []int) {
	t.Helper()
	opts := wb.Options
	opts.Reminders = reminders
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, types.WebinarInput{
		Topic: wb.Topic, StartsAt: starts.Format(time.RFC3339), Duration: 45,
		Kind: types.KindLive, Status: types.StatusScheduled, RegistrationRequired: true,
		Approval: types.ApprovalAutomatic, AttendeeLimit: 100, Options: opts,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("save webinar: status %d body %s", res.StatusCode, raw)
	}
}

type reminderRow struct {
	offset  int
	due     time.Time
	subject string
}

// pendingReminders is the unsent rows of one kind for a webinar, largest offset first.
func pendingReminders(t *testing.T, h *harness, slug string, kind types.NotificationKind) []reminderRow {
	t.Helper()
	rows, err := h.store.Pool().Query(context.Background(), `
		SELECT n.offset_min, n.due_at, n.subject FROM notifications n
		  JOIN webinars w ON w.id = n.webinar_id
		 WHERE w.slug = $1 AND n.kind = $2 AND n.delivery = 'pending'
		 ORDER BY n.offset_min DESC`, slug, string(kind))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []reminderRow
	for rows.Next() {
		var r reminderRow
		if err := rows.Scan(&r.offset, &r.due, &r.subject); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func offsetsOf(rows []reminderRow) []int {
	out := []int{}
	for _, r := range rows {
		out = append(out, r.offset)
	}
	return out
}

// A webinar that never says gets a day and an hour, as every webinar did before.
func TestRemindersDefaultAndValidate(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")

	wb, _ := reminderWebinar(t, h, nil)
	if !slices.Equal(wb.Options.Reminders, []int{1440, 60}) {
		t.Errorf("omitted reminders = %v, want [1440 60]", wb.Options.Reminders)
	}
	// Duplicates merge, and the order is the order they are sent in.
	wb, _ = reminderWebinar(t, h, []int{10, 1440, 10})
	if !slices.Equal(wb.Options.Reminders, []int{1440, 10}) {
		t.Errorf("reminders = %v, want [1440 10]", wb.Options.Reminders)
	}
	// None at all is a choice, and stays one.
	wb, _ = reminderWebinar(t, h, []int{})
	if len(wb.Options.Reminders) != 0 {
		t.Errorf("empty reminders = %v, want none", wb.Options.Reminders)
	}

	for name, bad := range map[string][]int{
		"four of them":     {1440, 60, 30, 10},
		"at the start":     {0},
		"after the start":  {-5},
		"over thirty days": {31 * 24 * 60},
	} {
		starts := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
		res, raw := h.do(http.MethodPost, "/api/host/webinars", map[string]any{
			"topic": "Bad", "startsAt": starts, "durationMin": 45, "status": "scheduled",
			"approval": "automatic", "options": map[string]any{"reminders": bad},
		})
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d body %s, want 422", name, res.StatusCode, raw)
		}
	}
}

/* The host's times are the ones queued, on both channels, and each says how far ahead it
 * is. Then the host edits them: a removed time's unsent reminders go, an added one is
 * queued for the people already registered, and moving the webinar moves the rest. */
func TestRemindersFollowTheHostsTimes(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppReminder, Template: testTemplateUtility,
		Language: "en_US", Params: []string{"starts_in"},
	})

	wb, starts := reminderWebinar(t, h, []int{1440, 30})
	registerOptedIn(t, h, wb.ID)

	email := pendingReminders(t, h, wb.ID, types.NotifyReminder)
	if got := offsetsOf(email); !slices.Equal(got, []int{1440, 30}) {
		t.Fatalf("email reminders queued for %v, want the host's times", got)
	}
	last := email[len(email)-1]
	if last.offset != 30 || !last.due.Equal(starts.Add(-30*time.Minute)) {
		t.Errorf("30m reminder due %v, want %v", last.due, starts.Add(-30*time.Minute))
	}
	if last.subject != "Starting in 30 minutes: Timed" {
		t.Errorf("subject = %q", last.subject)
	}
	if got := offsetsOf(pendingReminders(t, h, wb.ID, types.NotifyWhatsAppReminder)); !slices.Equal(got, []int{1440, 30}) {
		t.Errorf("whatsapp reminders queued for %v, want [1440 30]", got)
	}

	// Edit: drop 30 minutes, add 3 hours and 5 minutes, and move the start a day later.
	moved := starts.Add(24 * time.Hour)
	saveWebinar(t, h, wb, moved, []int{180, 5})

	for _, kind := range []types.NotificationKind{types.NotifyReminder, types.NotifyWhatsAppReminder} {
		rows := pendingReminders(t, h, wb.ID, kind)
		if got := offsetsOf(rows); !slices.Equal(got, []int{180, 5}) {
			t.Errorf("%s after the edit: %v, want [180 5]", kind, got)
			continue
		}
		for _, r := range rows {
			if want := moved.Add(-time.Duration(r.offset) * time.Minute); !r.due.Equal(want) {
				t.Errorf("%s %dm due %v, want %v", kind, r.offset, r.due, want)
			}
		}
	}
	if s := pendingReminders(t, h, wb.ID, types.NotifyReminder)[0].subject; s != "Starting in 3 hours: Timed" {
		t.Errorf("added reminder subject = %q", s)
	}

	// Saving again without changes queues nothing twice.
	saveWebinar(t, h, wb, moved, []int{180, 5})
	if n := len(pendingReminders(t, h, wb.ID, types.NotifyReminder)); n != 2 {
		t.Errorf("%d email reminders after a no-op save, want 2", n)
	}

	/* Moving the webinar to 2 hours from now: the 3-hour reminder is already late, and is
	 * dropped rather than sent saying "in 3 hours". The 5-minute one moves. */
	soon := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	saveWebinar(t, h, wb, soon, []int{180, 5})
	for _, kind := range []types.NotificationKind{types.NotifyReminder, types.NotifyWhatsAppReminder} {
		if got := offsetsOf(pendingReminders(t, h, wb.ID, kind)); !slices.Equal(got, []int{5}) {
			t.Errorf("%s after moving to two hours out: %v, want [5]", kind, got)
		}
	}

	// And none: every unsent reminder goes.
	saveWebinar(t, h, wb, soon, []int{})
	for _, kind := range []types.NotificationKind{types.NotifyReminder, types.NotifyWhatsAppReminder} {
		if got := pendingReminders(t, h, wb.ID, kind); len(got) != 0 {
			t.Errorf("%s with no reminder times: %v, want none", kind, offsetsOf(got))
		}
	}
}
