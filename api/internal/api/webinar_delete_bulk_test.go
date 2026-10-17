package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
)

// seedBulkChildren fills the tables a long webinar grows fastest, n rows each.
func seedBulkChildren(t *testing.T, h *harness, webinarID string, n int) {
	t.Helper()
	ctx := t.Context()
	for _, q := range []string{
		`INSERT INTO notifications (email, kind, webinar_id, subject, body, delivery)
		 SELECT 'bulk' || i || '@example.com', 'registration_confirmed', $1::uuid, 's', 'b', 'sent'
		   FROM generate_series(1, $2) i`,
		`INSERT INTO engagement_events (webinar_id, identity, kind, occurred_at)
		 SELECT $1::uuid, 'att_' || i, 'reaction', now() FROM generate_series(1, $2) i`,
		`INSERT INTO session_captions (webinar_id, identity, body)
		 SELECT $1::uuid, 'host', 'line ' || i FROM generate_series(1, $2) i`,
		`INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at)
		 SELECT $1::uuid, 'att_' || i, now() - interval '1 hour', now() FROM generate_series(1, $2) i`,
		`INSERT INTO chat_messages (id, webinar_id, sender_identity, sender_name, sender_role, content)
		 SELECT 'bulk-msg-' || lpad(i::text, 6, '0'), $1::uuid, 'att_' || i, 'Bulk', 'attendee', 'hi'
		   FROM generate_series(1, $2) i`,
	} {
		if _, err := h.store.Pool().Exec(ctx, q, webinarID, n); err != nil {
			t.Fatalf("seed: %v\n%s", err, q)
		}
	}
}

func bulkChildCount(t *testing.T, h *harness, webinarID string) int {
	t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(t.Context(), `
		SELECT (SELECT count(*) FROM notifications     WHERE webinar_id = $1::uuid)
		     + (SELECT count(*) FROM engagement_events WHERE webinar_id = $1::uuid)
		     + (SELECT count(*) FROM session_captions  WHERE webinar_id = $1::uuid)
		     + (SELECT count(*) FROM attendance_visits WHERE webinar_id = $1::uuid)
		     + (SELECT count(*) FROM chat_messages     WHERE webinar_id = $1::uuid)
		     + (SELECT count(*) FROM webinars          WHERE id = $1::uuid)`, webinarID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

/* A long webinar's history is purged in bounded batches before the row goes, and
 * nothing survives. The batch here is far smaller than the rows, so the loop has to
 * go round; the counted tables (chat) still come back in the result. */
func TestDeletingABigWebinarPurgesInBatches(t *testing.T) {
	h := newHarness(t)
	h.signup("Bulk Host", "bulk-host@test.dev", true)
	const rows = 3000

	wb := h.newWebinar("Long running series", nil)
	id := webinarUUID(t, h, wb.ID)
	seedBulkChildren(t, h, id, rows)
	if got := bulkChildCount(t, h, id); got != 5*rows+1 {
		t.Fatalf("seeded %d rows, want %d", got, 5*rows+1)
	}

	deleted, err := h.store.DeleteWebinarInBatches(t.Context(), wb.ID, 250)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if deleted.ChatMessages != rows {
		t.Errorf("chat messages counted = %d, want %d", deleted.ChatMessages, rows)
	}
	if left := bulkChildCount(t, h, id); left != 0 {
		t.Errorf("%d rows survived the delete", left)
	}
	if _, err := h.store.DeleteWebinarInBatches(t.Context(), wb.ID, 250); err != store.ErrNotFound {
		t.Errorf("second delete: err = %v, want ErrNotFound", err)
	}

	// The same through the endpoint, at the default batch size.
	other := h.newWebinar("Another long one", nil)
	otherID := webinarUUID(t, h, other.ID)
	seedBulkChildren(t, h, otherID, rows)
	res, raw := h.do(http.MethodDelete, "/api/host/webinars/"+other.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete through the API: status %d body %s", res.StatusCode, raw)
	}
	if left := bulkChildCount(t, h, otherID); left != 0 {
		t.Errorf("%d rows survived the API delete", left)
	}
}
