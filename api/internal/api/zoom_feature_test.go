package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* Zoom is a per-account switch, the same list as the other integrations'
 * switches. Off until an administrator turns it on. The card, connect, and
 * choosing Zoom when scheduling all refuse. The inbound webhook does not:
 * that call is Zoom's, and it has no account to check.
 */

func TestZoomIsOffUntilAnAdminAllowsIt(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Zoom Host", "zoom-host@test.dev", true)
	if hasFeature(host.Features, types.FeatureZoom) {
		t.Fatalf("new account features = %v, want zoom off", host.Features)
	}

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if !hasFeature(featureKeys(cfg.FeatureCatalogue), types.FeatureZoom) {
		t.Fatal("feature catalogue does not offer Zoom")
	}

	_, raw = h.do(http.MethodGet, "/api/host/integrations", nil)
	var cards types.IntegrationsResponse
	h.decode(raw, &cards)
	var whatsapp bool
	for _, c := range cards.Integrations {
		if c.ID == "zoom" {
			t.Fatalf("integrations listed Zoom without the switch: %+v", c)
		}
		if c.ID == "whatsapp" {
			whatsapp = true
		}
	}
	if !whatsapp {
		t.Fatal("hiding Zoom also hid WhatsApp")
	}

	res, raw := h.do(http.MethodGet, "/api/host/zoom/connect", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("connect: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	res, raw = h.do(http.MethodDelete, "/api/host/integrations/zoom", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("disconnect: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	in := policyInput("In Zoom", true, false)
	in.Venue = zoom.VenueMeeting
	res, raw = h.do(http.MethodPost, "/api/host/webinars", in)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("create: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	/* A webinar already pointed at Zoom cannot be started there, and a save
	 * that does not ask for Zoom does not call Zoom to leave. */
	wb := h.newWebinar("Already in Zoom", nil)
	wb = h.placeFixtureStart(wb.ID, time.Now())
	if err := h.store.SetWebinarZoom(context.Background(), wb.ID, zoom.VenueMeeting, "999", "https://zoom.us/s/host", ""); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/start", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("go live: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, types.WebinarInput{
		Topic: "Renamed", StartsAt: wb.StartsAt, Duration: wb.Duration, TimeZone: "UTC",
		Kind: types.KindLive, Status: types.StatusScheduled, Venue: zoom.VenueApp,
		RegistrationRequired: true, Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("leave zoom locally: status %d body %s", res.StatusCode, raw)
	}
	var left types.Webinar
	h.decode(raw, &left)
	if left.Venue != zoom.VenueApp || left.Topic != "Renamed" {
		t.Fatalf("after save without the switch: venue %q topic %q", left.Venue, left.Topic)
	}

	/* Zoom calling us is not this switch. A bad signature is still a bad
	 * signature, not feature_off. */
	res, raw = postAnonymous(t, h, "/api/webhooks/zoom", map[string]any{"event": "endpoint.url_validation"})
	if res.StatusCode != http.StatusUnauthorized || errorCode(t, raw) != "zoom_signature" {
		t.Fatalf("webhook: status %d code %q, want 401 zoom_signature\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureZoom, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("grant: status %d body %s", res.StatusCode, raw)
	}
	var updated types.Account
	h.decode(raw, &updated)
	if !hasFeature(updated.Features, types.FeatureZoom) {
		t.Fatalf("features after grant = %v", updated.Features)
	}

	h.login("zoom-host@test.dev")
	me := meAccount(t, h)
	if !hasFeature(me.Features, types.FeatureZoom) {
		t.Fatalf("/api/auth/me features = %v, want zoom on", me.Features)
	}
	_, raw = h.do(http.MethodGet, "/api/host/integrations", nil)
	h.decode(raw, &cards)
	var found bool
	for _, c := range cards.Integrations {
		if c.ID == "zoom" {
			found = true
		}
	}
	if !found {
		t.Fatal("integrations omitted Zoom after the switch was turned on")
	}
	res, raw = h.do(http.MethodGet, "/api/host/zoom/connect", nil)
	if res.StatusCode != http.StatusServiceUnavailable || errorCode(t, raw) != "zoom_not_configured" {
		t.Fatalf("connect once allowed: status %d code %q, want 503 zoom_not_configured\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	in = policyInput("In Zoom now", true, false)
	in.Venue = zoom.VenueMeeting
	res, raw = h.do(http.MethodPost, "/api/host/webinars", in)
	if res.StatusCode != http.StatusUnprocessableEntity || errorCode(t, raw) != "validation_failed" {
		t.Fatalf("create once allowed: status %d code %q, want 422 validation_failed\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
}
