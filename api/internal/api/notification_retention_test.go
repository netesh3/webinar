package api_test

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

// Sent email loses its body, HTML and calendar file 30 days after its webinar
// ends. Subject and status stay. Pending mail, the bell's in-app alerts, mail
// for a webinar that ended recently, and recent mail with no webinar are kept.
func TestNotificationContentRetention(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Retention Host", "notif-retention@example.com", true)
	oldWb := h.newWebinar("Ended long ago", nil)
	newWb := h.newWebinar("Ended last week", nil)
	ctx := t.Context()
	db := h.store.Pool()

	if _, err := db.Exec(ctx, `
		UPDATE webinars SET status = 'ended', ended_at = CASE slug
		       WHEN $1 THEN now() - interval '40 days'
		       ELSE now() - interval '5 days' END
		 WHERE slug IN ($1, $2)`, oldWb.ID, newWb.ID); err != nil {
		t.Fatal(err)
	}

	insert := func(label, webinarSlug, email, userID, delivery string, createdAgo time.Duration) {
		t.Helper()
		if _, err := db.Exec(ctx, `
			INSERT INTO notifications (email, user_id, kind, webinar_id, subject, body, html, ics, delivery, created_at)
			VALUES ($2, NULLIF($3,'')::uuid,
			        CASE WHEN $3 = '' THEN 'registration_confirmed' ELSE 'approval_requested' END,
			        (SELECT id FROM webinars WHERE slug = NULLIF($4,'')),
			        $1, 'body of '||$1, '<p>'||$1||'</p>', 'BEGIN:VCALENDAR', $5, now() - $6::interval)`,
			label, email, userID, webinarSlug, delivery, createdAgo); err != nil {
			t.Fatalf("insert %s: %v", label, err)
		}
	}
	day := 24 * time.Hour
	insert("old-sent", oldWb.ID, "a@example.com", "", "sent", 45*day)
	insert("old-failed", oldWb.ID, "b@example.com", "", "failed", 45*day)
	insert("old-pending", oldWb.ID, "c@example.com", "", "pending", 45*day)
	insert("old-alert", oldWb.ID, "", host.ID, "sent", 45*day)
	insert("recent-webinar", newWb.ID, "d@example.com", "", "sent", 45*day)
	insert("no-webinar-old", "", "e@example.com", "", "sent", 45*day)
	insert("no-webinar-new", "", "f@example.com", "", "sent", 2*day)

	n, err := h.store.PruneNotificationContent(ctx, time.Now().Add(-store.NotificationContentRetention), 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("cleared = %d, want 3", n)
	}

	rows, err := db.Query(ctx, `SELECT subject, body = '' AND html = '' AND ics = '', delivery FROM notifications WHERE subject LIKE '%-%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cleared := map[string]bool{}
	for rows.Next() {
		var subject, delivery string
		var empty bool
		if err := rows.Scan(&subject, &empty, &delivery); err != nil {
			t.Fatal(err)
		}
		cleared[subject] = empty
	}
	want := map[string]bool{
		"old-sent": true, "old-failed": true, "no-webinar-old": true,
		"old-pending": false, "old-alert": false, "recent-webinar": false, "no-webinar-new": false,
	}
	for subject, w := range want {
		if got, ok := cleared[subject]; !ok || got != w {
			t.Errorf("%s cleared = %v (present %v), want %v", subject, got, ok, w)
		}
	}
}
