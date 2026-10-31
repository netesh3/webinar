package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Pricing v3 (31 Oct 2026): Basic, Professional, Business and Enterprise on sale, Starter
 * grandfathered. See migrations/0179. */

// The migrated tier matrix is store.TierFeatures for every switch the plans differ by.
func TestTierMatrixIsTheLaunchMatrix(t *testing.T) {
	h := newHarness(t)
	tiers, err := h.store.PlanFeatures(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	byPlan := map[types.Plan][]string{}
	for _, tier := range tiers {
		byPlan[tier.Plan] = tier.Features
	}
	for plan, want := range store.TierFeatures {
		for _, k := range store.TieredFeatures {
			if got := slices.Contains(byPlan[plan], k); got != slices.Contains(want, k) {
				t.Errorf("%s includes %s = %v, want %v", plan, k, got, !got)
			}
		}
		// The switches every tier has: whiteboard and meetings.
		for _, k := range []string{types.FeatureWhiteboard, types.FeatureMeetings} {
			if !slices.Contains(byPlan[plan], k) {
				t.Errorf("%s lost %s", plan, k)
			}
		}
	}
	// The grandfathered tier keeps what Professional had before: none of the new switches, and
	// server captions, which it had from 0142 (migrations/0180 keeps them).
	for _, k := range store.PricingV3Features {
		if slices.Contains(byPlan[types.PlanStarter], k) {
			t.Errorf("starter gained %s", k)
		}
	}
	if !slices.Contains(byPlan[types.PlanStarter], types.FeatureCaptions) {
		t.Error("starter lost server captions")
	}
	// No plan captions on each speaker's device (1 Nov 2026).
	if slices.Contains(byPlan[""], types.FeatureCaptions) {
		t.Error("no plan still has server captions")
	}
	for _, tier := range tiers {
		for _, k := range []string{types.FeatureClips, types.FeatureInstantWebinar, types.FeatureHLSDelivery} {
			if slices.Contains(tier.Features, k) {
				t.Errorf("tier %q includes %s; it is per host only", tier.Plan, k)
			}
		}
	}
}

// A host on each plan has what the plan sells: WhatsApp from Professional, AI and simulive from Business.
func TestEntitlementsPerPlan(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	for _, c := range []struct {
		plan                    types.Plan
		whatsapp, ai, simulive  bool
		attendees, stage, meets int
	}{
		{types.PlanBasic, false, false, false, 100, 3, 10},
		{types.PlanProfessional, true, false, false, 300, 5, 20},
		{types.PlanBusiness, true, true, true, 500, 10, 100},
		{types.PlanEnterprise, true, true, true, 1000, 100, 300},
	} {
		acct := h.signup("Tier "+string(c.plan), "tier-v3-"+string(c.plan)+"@test.dev", true)
		if _, err := h.store.SetUserPlan(ctx, acct.ID, c.plan); err != nil {
			t.Fatal(err)
		}
		me := h.me()
		for k, want := range map[string]bool{
			types.FeatureWhatsAppCRM: c.whatsapp, types.FeatureAI: c.ai, types.FeatureAIKnowledge: c.ai,
			types.FeatureFollowupSend: c.ai, types.FeatureRepurpose: c.ai, types.FeatureSimulive: c.simulive,
			types.FeatureReplayEngage: c.simulive, types.FeatureSimuliveAuto: c.ai && c.simulive,
			types.FeatureZoom: c.ai, types.FeatureCloudRecording: c.whatsapp, types.FeatureClips: false,
			types.FeatureInstantWebinar: false, types.FeatureHLSDelivery: false, types.FeatureCaptions: c.ai,
		} {
			if hasFeature(me.Features, k) != want {
				t.Errorf("%s host: %s = %v, want %v (%v)", c.plan, k, !want, want, me.Features)
			}
		}
		if me.AttendeeCap != c.attendees {
			t.Errorf("%s host: attendee cap %d, want %d", c.plan, me.AttendeeCap, c.attendees)
		}
		plan, override, err := h.store.StageCapForUser(ctx, acct.ID)
		if err != nil || plan != c.plan || override != nil || types.PlanStageCap(plan) != c.stage {
			t.Errorf("%s host: stage plan %q override %v cap %d (err %v), want %d", c.plan, plan, override, types.PlanStageCap(plan), err, c.stage)
		}
		if types.PlanMeetingCap(c.plan) != c.meets {
			t.Errorf("%s: meeting cap %d, want %d", c.plan, types.PlanMeetingCap(c.plan), c.meets)
		}
	}
}

/* Starter is grandfathered: an account on it keeps its 200 attendees, 3 on stage and its name,
 * and may renew it at its price; nobody else can buy it or trial it, and the price list does
 * not show it. */
func TestStarterIsGrandfathered(t *testing.T) {
	h, _ := billingHarness(t)
	ctx := t.Context()

	// A new buyer is refused Starter, both ways, and the catalogue does not offer it.
	h.signup("New Buyer", "new-starter@example.com", true)
	res, raw := h.do(http.MethodPost, "/api/billing/orders", types.CreateBillingOrderRequest{Plan: "starter", Period: "monthly", Currency: "INR"})
	h.wantError(res, raw, http.StatusUnprocessableEntity, "plan_retired")
	h.setPhone("+91 98111 00179")
	if code, _, body := h.startTrial("starter"); code != http.StatusUnprocessableEntity || errorCode(t, []byte(body)) != "plan_retired" {
		t.Fatalf("starter trial: %d %s, want 422 plan_retired", code, body)
	}
	_, raw = h.do(http.MethodGet, "/api/billing/plans", nil)
	var cat types.BillingCatalogue
	h.decode(raw, &cat)
	for _, p := range cat.Plans {
		if p.ID == "starter" {
			t.Fatal("the catalogue offers starter")
		}
	}
	h.logout()

	// An existing Starter subscriber (migrations/0179 renamed their Professional).
	old := h.signup("Old Subscriber", "old-starter@example.com", true)
	if _, err := h.store.SetUserPlan(ctx, old.ID, types.PlanStarter); err != nil {
		t.Fatal(err)
	}
	if a := h.me(); a.Plan != types.PlanStarter || a.AttendeeCap != 200 {
		t.Fatalf("starter account: plan %q cap %d, want starter and 200", a.Plan, a.AttendeeCap)
	}
	if wb := h.newWebinar("Starter room", func(in *types.WebinarInput) { in.AttendeeLimit = 300 }); wb.AttendeeLimit != 200 {
		t.Fatalf("starter webinar asked 300 = %d, want 200", wb.AttendeeLimit)
	}
	plan, _, err := h.store.StageCapForUser(ctx, old.ID)
	if err != nil || types.PlanStageCap(plan) != 3 {
		t.Fatalf("starter stage cap = %d (err %v), want 3", types.PlanStageCap(plan), err)
	}
	// Renewing at the grandfathered price works, and the billing card names the plan.
	co := h.buy("starter", billing.Yearly, billing.INR)
	if co.Subtotal != 39_948_00 || co.PlanName != "Starter" {
		t.Fatalf("starter renewal: %+v, want ₹39,948 Starter", co)
	}
	res, raw = h.do(http.MethodPost, "/api/billing/verify", types.VerifyBillingPaymentRequest{
		OrderID: co.OrderID, PaymentID: "pay_starter",
		Signature: billing.Sign(rzpSecret, []byte(co.OrderID+"|pay_starter")),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("verify: %d %s", res.StatusCode, raw)
	}
	var vr types.VerifyBillingPaymentResponse
	h.decode(raw, &vr)
	if vr.Account.Plan != types.PlanStarter || vr.Billing.PlanName != "Starter" || vr.Billing.Attendees != 200 {
		t.Fatalf("after renewing: plan %q, billing %+v", vr.Account.Plan, vr.Billing)
	}
	if st := h.myBilling(); st.PlanName != "Starter" || !st.Active {
		t.Fatalf("billing card: %+v", st)
	}
	// Moving up to a plan on sale is an ordinary purchase.
	if co := h.buy("professional", billing.Monthly, billing.INR); co.Subtotal != 9_999_00 {
		t.Fatalf("starter moving to professional: %+v", co)
	}
}

func (h *harness) myBilling() types.BillingStatus {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/me/billing", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("me/billing: %d %s", res.StatusCode, raw)
	}
	var st types.BillingStatus
	h.decode(raw, &st)
	return st
}

/* migrations/0179 on the old shape: subscribers on professional, business and enterprise, a
 * matrix where an admin had given the old Business tier Zoom and the old Professional tier
 * instant webinars, and one subscriber with Zoom turned off for them. Everyone ends on the
 * renamed id with the same caps, keeps every switch they had (an override where the new tier
 * leaves it out), and the new tiers are the launch matrix. */
func TestPricingV3MigrationKeepsEverySubscribersLimitsAndSwitches(t *testing.T) {
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
		_, _ = h.store.Pool().Exec(context.Background(), `
			DELETE FROM plan_limits WHERE plan IN ('basic', 'enterprise');
			INSERT INTO plan_limits (plan, limit_key, value) VALUES
			    ('starter',      'recording_storage_bytes', 10::bigint  * 1024 * 1024 * 1024),
			    ('professional', 'recording_storage_bytes', 10::bigint  * 1024 * 1024 * 1024),
			    ('business',     'recording_storage_bytes', 100::bigint * 1024 * 1024 * 1024),
			    ('basic',        'recording_storage_bytes', 2::bigint   * 1024 * 1024 * 1024),
			    ('enterprise',   'recording_storage_bytes', 500::bigint * 1024 * 1024 * 1024)
			ON CONFLICT (plan, limit_key) DO UPDATE SET value = EXCLUDED.value`)
	})

	pro := h.signup("Old Pro", "mig179-pro@test.dev", true)
	biz := h.signup("Old Biz", "mig179-biz@test.dev", true)
	bizOff := h.signup("Old Biz Off", "mig179-biz-off@test.dev", true)
	ent := h.signup("Old Ent", "mig179-ent@test.dev", true)
	// The old shape: the plan_features and plan_limits rows and the subscriptions on the old ids.
	h.exec(`DELETE FROM plan_features WHERE plan <> ''`)
	h.exec(`DELETE FROM plan_limits WHERE plan <> ''`)
	h.exec(`INSERT INTO plan_features (plan, feature, enabled)
		SELECT p, f, true
		  FROM unnest(ARRAY['professional', 'business', 'enterprise']) AS p
		 CROSS JOIN unnest(ARRAY['whiteboard', 'meetings', 'captions']) AS f`)
	h.exec(`INSERT INTO plan_features (plan, feature, enabled) VALUES
		('business', 'zoom', true), ('business', 'whatsapp_crm', true),
		('professional', 'instant_webinar', true)`)
	h.exec(`INSERT INTO plan_limits (plan, limit_key, value) VALUES
		('professional', 'recording_storage_bytes', 10::bigint  * 1024 * 1024 * 1024),
		('business',     'recording_storage_bytes', 50::bigint  * 1024 * 1024 * 1024),
		('enterprise',   'recording_storage_bytes', 200::bigint * 1024 * 1024 * 1024)`)
	for id, plan := range map[string]string{pro.ID: "professional", biz.ID: "business", bizOff.ID: "business", ent.ID: "enterprise"} {
		h.exec(`INSERT INTO subscriptions (user_id, plan) VALUES ('` + id + `', '` + plan + `')
			ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan`)
	}
	forceFeature(t, h, bizOff.ID, types.FeatureZoom, false)
	capsBefore := map[string]int{}
	for _, id := range []string{pro.ID, biz.ID, ent.ID} {
		u, err := h.store.UserByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		capsBefore[id] = map[string]int{"professional": 200, "business": 300, "enterprise": 500}[string(u.Plan)]
	}

	if err := h.store.ConvertPricingV3(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ConvertPricingGates(ctx); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		id       string
		plan     types.Plan
		has, not []string
	}{
		// The old Professional is Starter, instant webinars gone with the tier (per host only).
		{pro.ID, types.PlanStarter, nil, []string{types.FeatureInstantWebinar, types.FeatureZoom}},
		// The old Business is Professional: WhatsApp from the tier, Zoom kept as their override.
		{biz.ID, types.PlanProfessional, []string{types.FeatureWhatsAppCRM, types.FeatureZoom}, nil},
		// Zoom was off for this one: it stays off, and is not made an override.
		{bizOff.ID, types.PlanProfessional, []string{types.FeatureWhatsAppCRM}, []string{types.FeatureZoom}},
		// The old Enterprise is Business: everything Business sells.
		{ent.ID, types.PlanBusiness, []string{types.FeatureAI, types.FeatureSimulive, types.FeatureZoom}, []string{types.FeatureClips}},
	} {
		u, err := h.store.UserByID(ctx, c.id)
		if err != nil {
			t.Fatal(err)
		}
		if u.Plan != c.plan {
			t.Errorf("%s: plan %q, want %q", c.id, u.Plan, c.plan)
		}
		if want, ok := capsBefore[c.id]; ok && types.PlanAttendeeCap(u.Plan) != want {
			t.Errorf("%s: attendee cap %d after, %d before", c.id, types.PlanAttendeeCap(u.Plan), want)
		}
		for _, k := range c.has {
			if !u.HasFeature(k) {
				t.Errorf("%s (%s) lost %s: %v", c.id, u.Plan, k, u.Features)
			}
		}
		for _, k := range c.not {
			if u.HasFeature(k) {
				t.Errorf("%s (%s) has %s: %v", c.id, u.Plan, k, u.Features)
			}
		}
	}
	// Zoom is an override for the old Business subscriber, not something the tier gives.
	var own bool
	if err := h.store.Pool().QueryRow(ctx, `SELECT 'zoom' = ANY (features) FROM users WHERE id = $1::uuid`, biz.ID).Scan(&own); err != nil || !own {
		t.Errorf("old business subscriber's zoom is not their own override (err %v)", err)
	}
	tiers, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range tiers {
		want, sold := store.TierFeatures[tier.Plan]
		if !sold {
			continue
		}
		for _, k := range store.TieredFeatures {
			if slices.Contains(tier.Features, k) != slices.Contains(want, k) {
				t.Errorf("tier %s: %s = %v after the migration", tier.Plan, k, !slices.Contains(want, k))
			}
		}
		if !slices.Contains(tier.Features, types.FeatureWhiteboard) {
			t.Errorf("tier %s has no whiteboard after the migration: %v", tier.Plan, tier.Features)
		}
	}
	// Storage moved with the ids, then 0180 set the plans on sale (Professional 10, Business 100).
	for id, gib := range map[string]int64{pro.ID: 10, biz.ID: 10, ent.ID: 100} {
		var q int64
		if err := h.store.Pool().QueryRow(ctx, `SELECT plan_recording_quota_bytes($1::uuid)`, id).Scan(&q); err != nil {
			t.Fatal(err)
		}
		if q != gib<<30 {
			t.Errorf("%s storage = %d, want %d GiB", id, q, gib)
		}
	}
}
