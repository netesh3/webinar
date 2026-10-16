package api_test

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func imagePayload(wamid, from, mediaID string) string {
	return fmt.Sprintf(`{"object":"whatsapp_business_account","entry":[{"id":%q,
	  "changes":[{"field":"messages","value":{
	    "messaging_product":"whatsapp",
	    "metadata":{"display_phone_number":"27820000000","phone_number_id":%q},
	    "contacts":[{"profile":{"name":"Photo Sender"},"wa_id":%q}],
	    "messages":[{"from":%q,"id":%q,"timestamp":"%d","type":"image",
	                 "image":{"id":%q,"mime_type":"image/jpeg","caption":"look"}}]}}]}]}`,
		testMetaWABAID, testMetaPhoneID, from, from, wamid, time.Now().Unix(), mediaID)
}

/* An inbound image is copied on the next tick, so it still loads after Meta has
 * forgotten it. Once the copy is past retention the endpoint says it expired. An
 * image Meta never served, and that was never copied, says the same. */
func TestWhatsAppImagesAreKeptAfterMetaForgetsThem(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	connectWhatsApp(t, h)
	ctx := t.Context()

	g.holdMedia("9001", []byte("jpeg-kept"))
	postWebhook(t, h, imagePayload("wamid.kept", "27831110001", "9001"))
	postWebhook(t, h, imagePayload("wamid.lost", "27831110002", "9002"))

	messageID := func(wamid string) string {
		t.Helper()
		var id string
		if err := h.store.Pool().QueryRow(ctx, `SELECT id::text FROM crm_messages WHERE wamid = $1`, wamid).Scan(&id); err != nil {
			t.Fatalf("message %s: %v", wamid, err)
		}
		return id
	}
	kept, lost := messageID("wamid.kept"), messageID("wamid.lost")

	h.engage.Tick(ctx)
	g.holdMedia("9001", nil)

	get := func(id string) (int, string) {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/host/crm/messages/"+id+"/media", nil)
		return res.StatusCode, string(raw)
	}
	if code, body := get(kept); code != http.StatusOK || body != "jpeg-kept" {
		t.Fatalf("kept image after Meta forgot it: %d %q", code, body)
	}
	if code, body := get(lost); code != http.StatusGone {
		t.Fatalf("image Meta never had: %d %s, want 410", code, body)
	}

	if _, err := h.store.Pool().Exec(ctx,
		`UPDATE crm_message_media SET stored_at = now() - interval '91 days' WHERE message_id = $1::uuid`, kept); err != nil {
		t.Fatal(err)
	}
	// The first tick took the once-a-day retention lease; let it run again.
	if _, err := h.store.Pool().Exec(ctx, `DELETE FROM sweep_leases WHERE name = 'wa-media-retention'`); err != nil {
		t.Fatal(err)
	}
	h.engage.Tick(ctx)
	if code, body := get(kept); code != http.StatusGone {
		t.Fatalf("image past retention: %d %s, want 410", code, body)
	}
	var key string
	if err := h.store.Pool().QueryRow(ctx,
		`SELECT storage_key FROM crm_message_media WHERE message_id = $1::uuid`, kept).Scan(&key); err != nil || key != "" {
		t.Fatalf("storage key after retention = %q, %v", key, err)
	}
}
