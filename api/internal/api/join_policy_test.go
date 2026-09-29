package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Join policy: registration is required, and a webinar is scheduled.
 *
 * Both are per-account switches that default to the restrictive state. The
 * browser hides the controls. These tests are the part that has to stay true
 * when the browser is not involved.
 */

func TestJoinWithoutRegistrationIsRejectedUntilAnAdminAllowsIt(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Open Host", "open-host@test.dev", true)
	if hasFeature(host.Features, types.FeatureJoinWithoutRegistration) {
		t.Fatalf("new account features = %v, want join-without-registration off", host.Features)
	}

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if !hasFeature(featureKeys(cfg.FeatureCatalogue), types.FeatureJoinWithoutRegistration) {
		t.Fatal("feature catalogue does not offer join without registration")
	}

	// An explicit false does not stick while the switch is off. Omitted would be
	// the same zero value; both are saved as required.
	res, raw := h.do(http.MethodPost, "/api/host/webinars", policyInput("Closed door", false, false))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d body %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	if !wb.RegistrationRequired {
		t.Fatal("registrationRequired false on create while the switch is off")
	}
	if wb.GuestJoinAllowed {
		t.Fatal("guest door advertised while the switch is off")
	}

	res, raw = h.guestJoin(wb.ID, "Walk In")
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "registration_required" {
		t.Fatalf("guest join: status %d code %q, want 403 registration_required\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	if n := h.registrantCount(wb.ID); n != 0 {
		t.Errorf("registrants %d, want 0: a refused guest must leave no row", n)
	}

	// The ordinary join, with no registration, is the same refusal. Signed in
	// but not registered, and not signed in at all.
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "not_registered" {
		t.Fatalf("signed-in join: status %d code %q, want 403 not_registered\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	res, raw = postAnonymous(t, h, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{})
	if res.StatusCode != http.StatusUnauthorized || errorCode(t, raw) != "no_join_key" {
		t.Fatalf("anonymous join: status %d code %q, want 401 no_join_key\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}

	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureJoinWithoutRegistration, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin enable: status %d body %s", res.StatusCode, raw)
	}
	var enabled types.Account
	h.decode(raw, &enabled)
	if !hasFeature(enabled.Features, types.FeatureJoinWithoutRegistration) {
		t.Fatalf("features after enable = %v", enabled.Features)
	}

	h.login("open-host@test.dev")
	me := meAccount(t, h)
	if !hasFeature(me.Features, types.FeatureJoinWithoutRegistration) {
		t.Fatalf("/api/auth/me features = %v, want the switch on", me.Features)
	}
	opened := policyInput(wb.Topic, false, false)
	opened.RegistrationRequired = false
	opened.StartsAt = wb.StartsAt
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, opened)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("turn registration off: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &wb)
	if wb.RegistrationRequired || !wb.GuestJoinAllowed {
		t.Fatalf("after the switch: registrationRequired %v guestJoinAllowed %v",
			wb.RegistrationRequired, wb.GuestJoinAllowed)
	}
	res, raw = h.guestJoin(wb.ID, "Walk In")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("guest join once allowed: status %d body %s", res.StatusCode, raw)
	}

	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureJoinWithoutRegistration, Enabled: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin disable: status %d body %s", res.StatusCode, raw)
	}

	// The row can still say registration is off. The join path does not trust it.
	h.login("open-host@test.dev")
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reload: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &wb)
	if wb.RegistrationRequired {
		t.Fatal("disabling the switch rewrote the webinar; the join path is what has to refuse")
	}
	if wb.GuestJoinAllowed {
		t.Fatal("guest door still advertised after the switch was turned off")
	}
	res, raw = h.guestJoin(wb.ID, "Walk In Again")
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "registration_required" {
		t.Fatalf("guest join after disable: status %d code %q, want 403 registration_required\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
}

func TestInstantWebinarIsRejectedUntilAnAdminAllowsIt(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Instant Host", "instant-host@test.dev", true)
	if hasFeature(host.Features, types.FeatureInstantWebinar) {
		t.Fatalf("new account features = %v, want instant webinar off", host.Features)
	}

	var cfg types.AppConfig
	_, raw := h.do(http.MethodGet, "/api/config", nil)
	h.decode(raw, &cfg)
	if !hasFeature(featureKeys(cfg.FeatureCatalogue), types.FeatureInstantWebinar) {
		t.Fatal("feature catalogue does not offer instant webinar")
	}

	before := hostWebinarCount(t, h, host.ID)
	res, raw := h.do(http.MethodPost, "/api/host/webinars", policyInput("Right now", true, true))
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("instant create: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
	if got := hostWebinarCount(t, h, host.ID); got != before {
		t.Fatalf("webinars %d after a refused instant create, want %d", got, before)
	}

	// Scheduling is unaffected.
	res, raw = h.do(http.MethodPost, "/api/host/webinars", policyInput("Next week", true, false))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("scheduled create: status %d body %s", res.StatusCode, raw)
	}

	if _, _, err := h.store.PromoteAdmins(context.Background(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureInstantWebinar, Enabled: true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin enable: status %d body %s", res.StatusCode, raw)
	}

	h.login("instant-host@test.dev")
	me := meAccount(t, h)
	if !hasFeature(me.Features, types.FeatureInstantWebinar) {
		t.Fatalf("/api/auth/me features = %v, want instant webinar on", me.Features)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars", policyInput("Going live", true, true))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("instant create once allowed: status %d body %s", res.StatusCode, raw)
	}

	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+host.ID+"/features",
		types.FeatureGrant{Feature: types.FeatureInstantWebinar, Enabled: false})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin disable: status %d body %s", res.StatusCode, raw)
	}
	h.login("instant-host@test.dev")
	res, raw = h.do(http.MethodPost, "/api/host/webinars", policyInput("Not any more", true, true))
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("instant create after disable: status %d code %q, want 403 feature_off\n  body: %s",
			res.StatusCode, errorCode(t, raw), raw)
	}
}

func policyInput(topic string, registration bool, instant bool) types.WebinarInput {
	return types.WebinarInput{
		Topic: topic, StartsAt: time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339),
		Duration: 60, TimeZone: "UTC",
		Kind: types.KindLive, Status: types.StatusScheduled,
		RegistrationRequired: registration, Approval: types.ApprovalAutomatic, AttendeeLimit: 100,
		Instant: instant,
	}
}

func hostWebinarCount(t *testing.T, h *harness, hostID string) int {
	t.Helper()
	n := 0
	for _, tab := range []store.HostWebinarTab{store.HostTabUpcoming, store.HostTabPast, store.HostTabDrafts} {
		page, err := h.store.ByHostPage(context.Background(), hostID, store.HostWebinarFilter{Tab: tab, Limit: 1})
		if err != nil {
			t.Fatalf("count webinars: %v", err)
		}
		switch tab {
		case store.HostTabPast:
			n += page.Counts.Past
		case store.HostTabDrafts:
			n += page.Counts.Drafts
		default:
			n += page.Counts.Upcoming
		}
	}
	return n
}

func postAnonymous(t *testing.T, h *harness, path string, body any) (*http.Response, []byte) {
	t.Helper()
	rawBody, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.Post(h.srv.URL+path, "application/json", bytes.NewReader(rawBody))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}
