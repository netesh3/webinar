package api_test

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

/* Erasing a contact takes their messages, the stored copies of their WhatsApp
 * attachments, and every send still queued for them; nothing more goes to their
 * number. Another host cannot do it. Registering again later makes a new contact. */
func TestDeleteCRMContactErasesThem(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	ctx := t.Context()
	db := h.store.Pool()

	wb := remindersWebinar(t, h, "Erasure webinar", true)
	thandi := registerOptedIn(t, h, wb.ID)

	g.holdMedia("9101", []byte("jpeg-of-thandi"))
	postWebhook(t, h, imagePayload("wamid.erase", crmPhoneDigits, "9101"))
	h.engage.Maintain(ctx)

	var key string
	if err := db.QueryRow(ctx, `
		SELECT c.storage_key FROM crm_message_media c
		  JOIN crm_messages m ON m.id = c.message_id
		 WHERE m.contact_id = $1::uuid`, thandi.ID).Scan(&key); err != nil || key == "" {
		t.Fatalf("stored media key = %q, %v; want a copy before deleting", key, err)
	}
	file := filepath.Join(h.recordingsDir, filepath.FromSlash(key))
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("stored media file: %v", err)
	}
	count := func(q string) int {
		t.Helper()
		var n int
		if err := db.QueryRow(ctx, q, thandi.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// A send due right now: the drain below would deliver it if it survived.
	if _, err := db.Exec(ctx, `
		INSERT INTO notifications (channel, kind, contact_id, webinar_id, template_name, template_language, subject, body, due_at)
		VALUES ('whatsapp', 'wa_registration_confirmed', $1::uuid, (SELECT id FROM webinars WHERE slug = $2),
		        $3, 'en_US', '', '', now())`, thandi.ID, wb.ID, testTemplateUtility); err != nil {
		t.Fatalf("queue a send: %v", err)
	}
	pendingQ := `SELECT count(*) FROM notifications WHERE contact_id = $1::uuid AND delivery = 'pending'`
	if count(pendingQ) == 0 {
		t.Fatal("want a WhatsApp send queued for the contact before deleting")
	}

	// Another host, and an id that is not one, are both "no such contact".
	h.signup("Other Host", "other-erase@test.dev", true)
	if res, raw := h.do(http.MethodDelete, "/api/host/crm/contacts/"+thandi.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("another host's delete: status %d body %s, want 404", res.StatusCode, raw)
	}
	h.login("neeraj@acme.dev")
	if res, _ := h.do(http.MethodDelete, "/api/host/crm/contacts/not-a-uuid", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("malformed id: status %d, want 404", res.StatusCode)
	}

	toThandi := func() int {
		n := 0
		for _, s := range g.sent() {
			if s["to"] == crmPhoneDigits {
				n++
			}
		}
		return n
	}
	before := toThandi()

	if res, raw := h.do(http.MethodDelete, "/api/host/crm/contacts/"+thandi.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("delete: status %d body %s", res.StatusCode, raw)
	}
	for name, q := range map[string]string{
		"contact":       `SELECT count(*) FROM crm_contacts WHERE id = $1::uuid`,
		"messages":      `SELECT count(*) FROM crm_messages WHERE contact_id = $1::uuid`,
		"notifications": `SELECT count(*) FROM notifications WHERE contact_id = $1::uuid`,
		"tags":          `SELECT count(*) FROM crm_contact_tags WHERE contact_id = $1::uuid`,
	} {
		if n := count(q); n != 0 {
			t.Errorf("%s left after delete: %d", name, n)
		}
	}
	var mediaRows int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM crm_message_media WHERE storage_key = $1`, key).Scan(&mediaRows); err != nil || mediaRows != 0 {
		t.Errorf("media rows left = %d, %v", mediaRows, err)
	}
	if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("stored media file after delete: %v, want it gone", err)
	}

	drainWhatsAppOutbox(t, h, wb.ID)
	if after := toThandi(); after != before {
		t.Errorf("sends to the erased number went from %d to %d", before, after)
	}
	if res, _ := h.do(http.MethodDelete, "/api/host/crm/contacts/"+thandi.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("second delete: status %d, want 404", res.StatusCode)
	}

	// Registering for another webinar later is a new person to this CRM.
	other := autoWebinar(t, h, "After erasure")
	again := registerWithPhone(t, h, other.ID, "Thandi", "thandi@example.com", crmContactPhone, true)
	if again.ID == "" || again.ID == thandi.ID {
		t.Errorf("contact after re-registering = %q, want a new one (old %q)", again.ID, thandi.ID)
	}
}
