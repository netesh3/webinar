package api_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* WhatsApp metrics: the page's five numbers, and the charge on a status callback.
 *
 * The aggregate is outbound only, inside the window. A category with no amount
 * is estimated from the rate table and labelled as such. An amount Meta did
 * send is stored exactly and is not an estimate.
 */

func TestCRMMetricsAggregatesTheWindow(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	ctx := context.Background()
	hostID := userID(t, h, "neeraj@acme.dev")
	contactID := insertContact(t, h, hostID, "+919800011199")

	now := time.Now().UTC().Truncate(time.Second)
	inside := now.Add(-time.Hour)
	outside := now.Add(-40 * 24 * time.Hour)
	insertOutbound(t, h, hostID, contactID, "wamid.M1", "read", "", 130_000, true, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M2", "read", "", 130_000, true, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M3", "delivered", "", 130_000, false, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M4", "failed", "131026: Message undeliverable", 0, false, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M5", "failed", "131026: Message undeliverable", 0, false, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M6", "failed", "131042: There is no payment method on this account.", 0, false, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M7", "queued", "", 0, false, inside)
	insertOutbound(t, h, hostID, contactID, "wamid.M8", "read", "", 130_000, true, outside)
	// An inbound row is stored delivered and must not count.
	if _, err := h.store.Pool().Exec(ctx, `
		INSERT INTO crm_messages (host_id, contact_id, direction, body, wamid, status, created_at)
		VALUES ($1::uuid, $2::uuid, 'in', 'hi', 'wamid.IN', 'delivered', $3)`,
		hostID, contactID, inside); err != nil {
		t.Fatal(err)
	}

	from := now.Add(-48 * time.Hour).Format(time.RFC3339)
	to := now.Add(time.Minute).Format(time.RFC3339)
	res, raw := h.do(http.MethodGet, "/api/host/crm/metrics?from="+from+"&to="+to, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("metrics: %d %s", res.StatusCode, raw)
	}
	var out types.CRMMetricsResponse
	h.decode(raw, &out)
	if out.Sent != 6 || out.Delivered != 3 || out.Read != 2 || out.Failed != 3 {
		t.Fatalf("counts sent=%d delivered=%d read=%d failed=%d, want 6/3/2/3",
			out.Sent, out.Delivered, out.Read, out.Failed)
	}
	if out.CostMicros != 390_000 || !out.CostEstimated || out.Currency != "INR" {
		t.Fatalf("cost %d estimated=%v currency=%s", out.CostMicros, out.CostEstimated, out.Currency)
	}
	if len(out.Failures) != 2 || out.Failures[0].Count != 2 || out.Failures[0].Code != "131026" {
		t.Fatalf("failures = %+v", out.Failures)
	}
	if out.Failures[0].Fix == "" || out.Failures[1].Code != "131042" {
		t.Fatalf("fixes = %+v", out.Failures)
	}

	res, raw = h.do(http.MethodGet, "/api/host/crm/metrics?from=not-a-date", nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad from: %d %s", res.StatusCode, raw)
	}
}

func TestCRMWebinarMetricsFiltersByWebinarAndKind(t *testing.T) {
	h := newHarness(t)
	h.login("neeraj@acme.dev")
	hostID := userID(t, h, "neeraj@acme.dev")
	c1 := insertContact(t, h, hostID, "+919800011177")
	c2 := insertContact(t, h, hostID, "+919800011166")
	mine := h.newWebinar("Morning Routines That Stick", nil)
	other := h.newWebinar("A different webinar", nil)
	mineID := webinarUUID(t, h, mine.ID)
	otherID := webinarUUID(t, h, other.ID)

	// Six automatic sends, one manual reply, plus rows that must not count.
	linkWebinarMessage(t, h, hostID, c1, mineID, "wa_registration_confirmed", "wamid.W1", "read", "", 130_000, true)
	linkWebinarMessage(t, h, hostID, c1, mineID, "wa_reminder", "wamid.W2", "delivered", "", 130_000, false)
	linkWebinarMessage(t, h, hostID, c2, mineID, "wa_reminder", "wamid.W3", "failed", "131026: Message undeliverable", 0, false)
	linkWebinarMessage(t, h, hostID, c2, mineID, "wa_replay", "wamid.W4", "read", "", 130_000, true)
	linkWebinarMessage(t, h, hostID, c1, mineID, "wa_drip", "wamid.W5", "sent", "", 0, false)
	linkWebinarMessage(t, h, hostID, c1, mineID, "wa_broadcast", "wamid.W6", "read", "", 130_000, true)
	linkWebinarMessage(t, h, hostID, c1, mineID, "", "wamid.W7", "sent", "", 0, false)
	linkWebinarMessage(t, h, hostID, c1, mineID, "wa_reminder", "wamid.W8", "queued", "", 0, false)
	linkWebinarMessage(t, h, hostID, c1, otherID, "wa_registration_confirmed", "wamid.W9", "read", "", 130_000, true)
	if _, err := h.store.Pool().Exec(context.Background(), `
		INSERT INTO crm_messages (host_id, contact_id, direction, body, wamid, status, webinar_id)
		VALUES ($1::uuid, $2::uuid, 'in', 'hi', 'wamid.WIN', 'delivered', $3::uuid)`,
		hostID, c1, mineID); err != nil {
		t.Fatal(err)
	}

	res, raw := h.do(http.MethodGet, "/api/host/crm/webinars/"+mine.ID+"/metrics", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("metrics: %d %s", res.StatusCode, raw)
	}
	var out types.CRMWebinarMetricsResponse
	h.decode(raw, &out)
	if out.Sent != 7 || out.Delivered != 4 || out.Read != 3 || out.Failed != 1 || out.People != 2 {
		t.Fatalf("counts sent=%d delivered=%d read=%d failed=%d people=%d, want 7/4/3/1/2",
			out.Sent, out.Delivered, out.Read, out.Failed, out.People)
	}
	if out.CostMicros != 520_000 || !out.CostEstimated || out.Currency != "INR" {
		t.Fatalf("cost %d estimated=%v currency=%s", out.CostMicros, out.CostEstimated, out.Currency)
	}
	if out.ByKind.Confirmation != 1 || out.ByKind.Reminders != 2 || out.ByKind.Replay != 1 || out.ByKind.FollowUps != 2 {
		t.Fatalf("by kind = %+v", out.ByKind)
	}
	if len(out.Failures) != 1 || out.Failures[0].Count != 1 || out.Failures[0].Code != "131026" {
		t.Fatalf("failures = %+v", out.Failures)
	}

	res, raw = h.do(http.MethodGet, "/api/host/crm/webinars/not-a-real-webinar/metrics", nil)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("missing webinar: %d %s", res.StatusCode, raw)
	}

	h.signup("Other Host", "other-metrics@acme.dev", true)
	res, raw = h.do(http.MethodGet, "/api/host/crm/webinars/"+mine.ID+"/metrics", nil)
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("other host: %d %s", res.StatusCode, raw)
	}
}

func webinarUUID(t *testing.T, h *harness, slug string) string {
	t.Helper()
	var id string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT id::text FROM webinars WHERE slug = $1`, slug).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

/* linkWebinarMessage writes one outbound row for a webinar, and the outbox row
 * that says which kind it was. An empty kind is a manual send: it counts in the
 * totals and in nobody's bucket. */
func linkWebinarMessage(t *testing.T, h *harness, hostID, contactID, webinarID, kind, wamid, status, failure string, micros int64, estimated bool) {
	t.Helper()
	ctx := context.Background()
	var notifID *string
	if kind != "" {
		var offset *int
		var broadcastID, dripID *string
		switch kind {
		case "wa_reminder":
			n := 60
			offset = &n
		case "wa_broadcast":
			var id string
			if err := h.store.Pool().QueryRow(ctx, `
				INSERT INTO crm_broadcasts
					(host_id, name, template_name, template_language, audience, webinar_id, scheduled_at)
				VALUES ($1::uuid, 'Follow up', 'thanks', 'en', 'webinar', $2::uuid, now())
				RETURNING id::text`, hostID, webinarID).Scan(&id); err != nil {
				t.Fatal(err)
			}
			broadcastID = &id
		case "wa_drip":
			var drip, enroll string
			if err := h.store.Pool().QueryRow(ctx, `
				INSERT INTO crm_drips (host_id, name, trigger_kind, webinar_id)
				VALUES ($1::uuid, 'After', 'ended', $2::uuid)
				RETURNING id::text`, hostID, webinarID).Scan(&drip); err != nil {
				t.Fatal(err)
			}
			if err := h.store.Pool().QueryRow(ctx, `
				INSERT INTO crm_drip_enrollments (drip_id, contact_id, webinar_id)
				VALUES ($1::uuid, $2::uuid, $3::uuid)
				RETURNING id::text`, drip, contactID, webinarID).Scan(&enroll); err != nil {
				t.Fatal(err)
			}
			dripID = &enroll
		}
		var id string
		if err := h.store.Pool().QueryRow(ctx, `
			INSERT INTO notifications
				(kind, channel, contact_id, template_name, webinar_id, subject, body,
				 delivery, offset_min, broadcast_id, drip_enrollment_id)
			VALUES ($1, 'whatsapp', $2::uuid, 'tmpl', $3::uuid, '', '',
			        'sent', $4, $5::uuid, $6::uuid)
			RETURNING id::text`,
			kind, contactID, webinarID, offset, broadcastID, dripID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		notifID = &id
	}
	var cost any
	if micros != 0 {
		cost = micros
	}
	if _, err := h.store.Pool().Exec(ctx, `
		INSERT INTO crm_messages
			(host_id, contact_id, direction, body, wamid, status, error,
			 cost_micros, cost_estimated, notification_id, webinar_id)
		VALUES ($1::uuid, $2::uuid, 'out', 'hello', $3, $4, $5, $6, $7, $8::uuid, $9::uuid)`,
		hostID, contactID, wamid, status, failure, cost, estimated, notifID, webinarID); err != nil {
		t.Fatal(err)
	}
}

func TestWhatsAppWebhookStoresPricing(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	h.do(http.MethodPost, "/api/host/whatsapp/callback", types.WhatsAppCallbackRequest{
		Code: "c", WABAID: testMetaWABAID, PhoneNumberID: testMetaPhoneID,
	})
	hostID := userID(t, h, "neeraj@acme.dev")
	contactID := insertContact(t, h, hostID, "+919800011188")
	insertOutbound(t, h, hostID, contactID, "wamid.EST", "sent", "", 0, false, time.Now().UTC())
	insertOutbound(t, h, hostID, contactID, "wamid.EXACT", "sent", "", 0, false, time.Now().UTC())

	postWebhook(t, h, statusWithPricing("wamid.EST", "delivered", "919800011188",
		`{"billable":true,"pricing_model":"PMP","category":"utility"}`))
	postWebhook(t, h, statusWithPricing("wamid.EXACT", "delivered", "919800011188",
		`{"billable":true,"category":"marketing","amount":0.78}`))

	estMicros, estFlag, estCat := messageCost(t, h, "wamid.EST")
	if estMicros != 130_000 || !estFlag || estCat != "utility" {
		t.Fatalf("estimate = %d estimated=%v category=%s, want 130000 true utility", estMicros, estFlag, estCat)
	}
	exactMicros, exactFlag, exactCat := messageCost(t, h, "wamid.EXACT")
	if exactMicros != 780_000 || exactFlag || exactCat != "marketing" {
		t.Fatalf("exact = %d estimated=%v category=%s, want 780000 false marketing", exactMicros, exactFlag, exactCat)
	}

	// A later callback that only repeats the status must not replace an exact
	// amount with an estimate.
	postWebhook(t, h, statusWithPricing("wamid.EXACT", "read", "919800011188",
		`{"billable":true,"category":"marketing"}`))
	again, againFlag, _ := messageCost(t, h, "wamid.EXACT")
	if again != 780_000 || againFlag {
		t.Fatalf("exact amount overwritten: %d estimated=%v", again, againFlag)
	}
}

func statusWithPricing(wamid, status, recipient, pricing string) string {
	return fmt.Sprintf(`{"entry":[{"id":%q,"changes":[{"field":"messages","value":{
	  "metadata":{"phone_number_id":%q},
	  "statuses":[{"id":%q,"status":%q,"timestamp":"1700000100","recipient_id":%q,"pricing":%s}]}}]}]}`,
		testMetaWABAID, testMetaPhoneID, wamid, status, recipient, pricing)
}

func userID(t *testing.T, h *harness, email string) string {
	t.Helper()
	var id string
	if err := h.store.Pool().QueryRow(context.Background(),
		`SELECT id::text FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func insertContact(t *testing.T, h *harness, hostID, phone string) string {
	t.Helper()
	var id string
	if err := h.store.Pool().QueryRow(context.Background(), `
		INSERT INTO crm_contacts (host_id, phone, name, source)
		VALUES ($1::uuid, $2, 'Divya', 'test') RETURNING id::text`, hostID, phone).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func insertOutbound(t *testing.T, h *harness, hostID, contactID, wamid, status, failure string, micros int64, estimated bool, at time.Time) {
	t.Helper()
	var cost any
	if micros != 0 {
		cost = micros
	}
	if _, err := h.store.Pool().Exec(context.Background(), `
		INSERT INTO crm_messages
			(host_id, contact_id, direction, body, wamid, status, error, cost_micros, cost_estimated, created_at)
		VALUES ($1::uuid, $2::uuid, 'out', 'hello', $3, $4, $5, $6, $7, $8)`,
		hostID, contactID, wamid, status, failure, cost, estimated, at); err != nil {
		t.Fatal(err)
	}
}

func messageCost(t *testing.T, h *harness, wamid string) (micros int64, estimated bool, category string) {
	t.Helper()
	var n *int64
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT cost_micros, cost_estimated, pricing_category FROM crm_messages WHERE wamid = $1`, wamid).
		Scan(&n, &estimated, &category); err != nil {
		t.Fatal(err)
	}
	if n != nil {
		micros = *n
	}
	return micros, estimated, category
}
