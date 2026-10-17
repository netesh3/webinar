package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The admin WhatsApp usage report tells reminders-only hosts apart from hosts
 * that use the CRM. One host only sends automatic reminders; the other also
 * broadcasts and replies from the inbox. Only admins may read it. */
func TestAdminWhatsAppUsage(t *testing.T) {
	h := newHarness(t)
	quiet := h.signup("Reminder Coach", "wa-quiet@test.dev", true)
	busy := h.signup("CRM Coach", "wa-busy@test.dev", true)
	ctx := t.Context()
	db := h.store.Pool()

	for _, id := range []string{quiet.ID, busy.ID} {
		if _, err := db.Exec(ctx, `
			UPDATE users SET whatsapp_access_token = 'tok', whatsapp_connected_at = now()
			 WHERE id = $1::uuid`, id); err != nil {
			t.Fatal(err)
		}
	}
	contact := func(host, phone string) string {
		t.Helper()
		var id string
		if err := db.QueryRow(ctx, `
			INSERT INTO crm_contacts (host_id, phone, name) VALUES ($1::uuid, $2, 'Guest')
			RETURNING id::text`, host, phone).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	// One sent automatic message of the given outbox kind.
	auto := func(host, contactID, kind string) {
		t.Helper()
		var nid string
		if err := db.QueryRow(ctx, `
			INSERT INTO notifications (channel, contact_id, kind, subject, body, template_name, delivery)
			VALUES ('whatsapp', $1::uuid, $2, '', '', 'tmpl', 'sent') RETURNING id::text`,
			contactID, kind).Scan(&nid); err != nil {
			t.Fatalf("notification %s: %v", kind, err)
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO crm_messages (host_id, contact_id, direction, body, status, notification_id)
			VALUES ($1::uuid, $2::uuid, 'out', 'auto', 'sent', $3::uuid)`, host, contactID, nid); err != nil {
			t.Fatal(err)
		}
	}
	message := func(host, contactID, direction string, manual bool) {
		t.Helper()
		if _, err := db.Exec(ctx, `
			INSERT INTO crm_messages (host_id, contact_id, direction, body, status, manual)
			VALUES ($1::uuid, $2::uuid, $3, 'hi', 'sent', $4)`, host, contactID, direction, manual); err != nil {
			t.Fatal(err)
		}
	}

	qc := contact(quiet.ID, "+919800000001")
	auto(quiet.ID, qc, "wa_registration_confirmed")
	auto(quiet.ID, qc, "wa_registration_confirmed")
	message(quiet.ID, qc, "in", false) // a reply arriving is not the host using the inbox

	bc := contact(busy.ID, "+919800000002")
	auto(busy.ID, bc, "wa_registration_confirmed")
	var broadcast string
	if err := db.QueryRow(ctx, `
		INSERT INTO crm_broadcasts (host_id, name, template_name, template_language, audience, scheduled_at)
		VALUES ($1::uuid, 'Launch', 'tmpl', 'en', 'opted_in', now()) RETURNING id::text`, busy.ID).Scan(&broadcast); err != nil {
		t.Fatalf("broadcast: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO crm_messages (host_id, contact_id, direction, body, status, broadcast_id)
		VALUES ($1::uuid, $2::uuid, 'out', 'news', 'sent', $3::uuid)`, busy.ID, bc, broadcast); err != nil {
		t.Fatal(err)
	}
	message(busy.ID, bc, "in", false)
	message(busy.ID, bc, "out", true)

	// A plain host may not read it.
	if res, _ := h.do(http.MethodGet, "/api/admin/stats/whatsapp", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-admin: status %d, want 403", res.StatusCode)
	}

	if _, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/stats/whatsapp?days=7", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("usage: status %d body %s", res.StatusCode, raw)
	}
	var usage types.AdminWhatsAppUsage
	h.decode(raw, &usage)
	if usage.Days != 7 {
		t.Errorf("days = %d, want 7", usage.Days)
	}
	by := map[string]types.AdminWhatsAppHostUsage{}
	for _, u := range usage.Hosts {
		by[u.Email] = u
	}
	q, b := by["wa-quiet@test.dev"], by["wa-busy@test.dev"]
	if q.Reminders != 2 || q.Broadcasts != 0 || q.ManualReplies != 0 || q.InboundReplies != 1 || !q.Connected {
		t.Errorf("reminders-only host = %+v", q)
	}
	if b.Reminders != 1 || b.Broadcasts != 1 || b.ManualReplies != 1 || b.InboundReplies != 1 || b.LastActiveAt == "" {
		t.Errorf("CRM host = %+v", b)
	}
	s := usage.Summary
	if s.RemindersOnly < 1 || s.UsedCRM < 1 || s.Broadcasts < 1 || s.Inbox < 1 {
		t.Errorf("summary = %+v, want at least one reminders-only and one CRM host", s)
	}
}
