package api_test

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Pricing gates (1 Nov 2026): WhatsApp messages need WhatsApp on the plan (whatsapp_crm,
 * Professional and up), and server captions are Business and up (migrations/0180). */

// A Basic host cannot turn WhatsApp messages on; a Professional host can.
func TestWhatsAppMessagesNeedProfessional(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	me := h.me()
	connectWhatsAppOnly(t, h)
	if _, err := h.store.SetUserPlan(t.Context(), me.ID, types.PlanBasic); err != nil {
		t.Fatal(err)
	}
	waReplay := types.MessageSlot{
		Kind: types.SlotReplay, Channels: []string{types.ChannelWhatsApp},
		Timing: types.MessageTiming{Type: types.TimingOnPublish}, Enabled: true,
	}
	res, raw := h.do(http.MethodPut, "/api/host/crm/message-defaults", types.MessageDefaultsRequest{Slots: []types.MessageSlot{waReplay}})
	h.wantError(res, raw, http.StatusForbidden, "whatsapp_plan")
	res, raw = h.do(http.MethodPut, "/api/host/crm/reminders", types.CRMRemindersRequest{Reminders: []types.CRMReminder{{
		Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility, Language: "en_US", Params: []string{"name"},
	}}})
	h.wantError(res, raw, http.StatusForbidden, "whatsapp_plan")
	// Email stays every plan's: an email-only save on Basic is fine.
	emailReplay := waReplay
	emailReplay.Channels = []string{types.ChannelEmail}
	putDefaults(t, h, emailReplay)

	if _, err := h.store.SetUserPlan(t.Context(), me.ID, types.PlanProfessional); err != nil {
		t.Fatal(err)
	}
	putDefaults(t, h, waReplay)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility, Language: "en_US", Params: []string{"name"},
	})
}

/* The sender sends nothing on WhatsApp for a host without it, and holds the message rather
 * than dropping it: with WhatsApp back (an upgrade, or an admin's override) it goes. */
func TestWhatsAppSenderSkipsAHostWithoutWhatsApp(t *testing.T) {
	g := newFakeGraph(t)
	h := newHarness(t, whatsappConfigured(g.srv.URL))
	h.login("neeraj@acme.dev")
	me := h.me()
	connectWhatsApp(t, h)
	setReminders(t, h, types.CRMReminder{
		Kind: types.NotifyWhatsAppConfirmed, Template: testTemplateUtility, Language: "en_US", Params: []string{"name"},
	})
	wb := remindersWebinar(t, h, "Gated confirmation", true)
	forceFeature(t, h, me.ID, types.FeatureWhatsAppCRM, false)

	registerOptedIn(t, h, wb.ID)
	if sends := g.sent(); len(sends) != 0 {
		t.Fatalf("%d WhatsApp sends for a host without WhatsApp: %v", len(sends), sends)
	}
	if pending, err := h.crm.PendingWhatsApp(context.Background(), 100); err != nil || len(pending) != 0 {
		t.Fatalf("pending for a host without WhatsApp = %d (err %v), want none", len(pending), err)
	}
	forceFeature(t, h, me.ID, types.FeatureWhatsAppCRM, true)
	if pending, err := h.crm.PendingWhatsApp(context.Background(), 100); err != nil || len(pending) != 1 {
		t.Fatalf("pending once WhatsApp is back = %d (err %v), want the held confirmation", len(pending), err)
	}
}

// Server captions: refused on a plan without them, with a message the room shows; allowed on Business.
func TestServerCaptionsAreBusinessAndUp(t *testing.T) {
	h := newHarness(t, captionsConfig)
	ctx := t.Context()
	acct := h.signup("Captions Plan Host", "captions-plan@test.dev", true)
	for _, c := range []struct {
		plan types.Plan
		want bool
	}{
		{"", false}, {types.PlanBasic, false}, {types.PlanProfessional, false},
		{types.PlanStarter, true}, {types.PlanBusiness, true}, {types.PlanEnterprise, true},
	} {
		if _, err := h.store.SetUserPlan(ctx, acct.ID, c.plan); err != nil {
			t.Fatal(err)
		}
		if got := hasFeature(h.me().Features, types.FeatureCaptions); got != c.want {
			t.Errorf("plan %q: server captions = %v, want %v", c.plan, got, c.want)
		}
	}
	if _, err := h.store.SetUserPlan(ctx, acct.ID, types.PlanBasic); err != nil {
		t.Fatal(err)
	}
	wb := h.liveWebinar("Basic captions", nil)
	res, _, raw := h.setServerCaptions(wb.ID, true)
	h.wantError(res, raw, http.StatusForbidden, "feature_off")
	if !strings.Contains(string(raw), "AI Live captions are on Business and up") {
		t.Errorf("refusal does not name the plans: %s", raw)
	}
	// The ordinary switch still turns captions on: they run on each speaker's device.
	on := true
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &on})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("device captions on Basic: %d %s", res.StatusCode, raw)
	}

	// One live session per host: a second host, on Business.
	other := h.signup("Captions Business Host", "captions-business@test.dev", true)
	if _, err := h.store.SetUserPlan(ctx, other.ID, types.PlanBusiness); err != nil {
		t.Fatal(err)
	}
	biz := h.liveWebinar("Business captions", nil)
	if res, _, raw := h.setServerCaptions(biz.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("server captions on Business: %d %s", res.StatusCode, raw)
	}
}

/* Storage that is already full (a lower plan limit, migrations/0180) refuses a new cloud
 * recording, and deletes nothing; with room again, recording starts. */
func TestNewCloudRecordingRefusedWhenStorageIsFull(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Full Storage Host", "storage-full@test.dev", true)
	wb := h.liveWebinar("Full storage", nil)
	readyRecording(t, h, wb.ID)
	h.exec(`UPDATE users SET recording_quota_bytes = 10 WHERE id = '` + host.ID + `'`)

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: `video/webm;codecs="vp9,opus"`})
	h.wantError(res, raw, http.StatusConflict, "quota_exceeded")
	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	if !strings.Contains(string(raw), `"status":"ready"`) {
		t.Fatalf("the recording already kept is gone: %s", raw)
	}

	h.exec(`UPDATE users SET recording_quota_bytes = NULL WHERE id = '` + host.ID + `'`)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: `video/webm;codecs="vp9,opus"`}); res.StatusCode != http.StatusCreated {
		t.Fatalf("with room again: %d %s", res.StatusCode, raw)
	}
}

/* migrations/0180 on the old shape: a Basic subscriber whose tier gave them cloud recording, and
 * a Professional one with server captions, keep them as their own; the tiers lose them. */
func TestPricingGatesMigrationKeepsWhatSubscribersHad(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	original, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.store.SetPlanFeatures(context.Background(), original); err != nil {
			t.Errorf("restore plan features: %v", err)
		}
	})
	basic := h.signup("Gates Basic", "gates-basic@test.dev", true)
	pro := h.signup("Gates Pro", "gates-pro@test.dev", true)
	for id, plan := range map[string]types.Plan{basic.ID: types.PlanBasic, pro.ID: types.PlanProfessional} {
		if _, err := h.store.SetUserPlan(ctx, id, plan); err != nil {
			t.Fatal(err)
		}
	}
	h.exec(`INSERT INTO plan_features (plan, feature, enabled) VALUES
		('basic', 'cloud_recording', true), ('professional', 'captions', true)
		ON CONFLICT (plan, feature) DO UPDATE SET enabled = true`)
	if err := h.store.ConvertPricingGates(ctx); err != nil {
		t.Fatal(err)
	}
	if u, _ := h.store.UserByID(ctx, basic.ID); !u.HasFeature(types.FeatureCloudRecording) {
		t.Errorf("the Basic subscriber lost cloud recording: %v", u.Features)
	}
	if u, _ := h.store.UserByID(ctx, pro.ID); !u.HasFeature(types.FeatureCaptions) {
		t.Errorf("the Professional subscriber lost server captions: %v", u.Features)
	}
	tiers, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range tiers {
		if tier.Plan == types.PlanBasic && slices.Contains(tier.Features, types.FeatureCloudRecording) {
			t.Error("the Basic tier still includes cloud recording")
		}
		if tier.Plan == types.PlanProfessional && slices.Contains(tier.Features, types.FeatureCaptions) {
			t.Error("the Professional tier still includes server captions")
		}
	}
}
