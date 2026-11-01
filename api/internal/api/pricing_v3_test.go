package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/billing"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Pricing v3 (31 Oct 2026): Basic, Professional, Business and Enterprise on sale. See
 * migrations/0179. The grandfathered Starter of 0179 was retired into Professional on 2 Nov 2026
 * (migrations/0185). */

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
	// Starter is gone (migrations/0185): no tier rows left for it.
	if _, ok := byPlan["starter"]; ok {
		t.Errorf("a starter tier is left: %v", byPlan["starter"])
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

/* Starter retired (2 Nov 2026, migrations/0185): an account the old shape had on the ₹3,999
 * Starter is on Professional after it, with server captions and Google Drive kept as its own
 * overrides (Starter's tier had them, Professional's does not) unless they were off for it.
 * Its running Razorpay subscription keeps the ₹3,999 amount it was created with: the renewal is
 * matched by subscription id, so it keeps the account on Professional rather than being refused,
 * and an unpaid one-time Starter order still fulfils at the amount it was created for. */
func TestRetiredStarterMovesToProfessionalAndKeepsRenewing(t *testing.T) {
	h, _ := billingHarness(t)
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

	// Subscriber: a Razorpay subscription, started as a Professional trial and then written
	// back to the old shape (Starter, ₹3,999 a month).
	sub := h.signup("Old Starter Sub", "retire-sub@example.com", false)
	h.setPhone("+91 98111 00185")
	code, co, raw := h.startTrial("professional")
	if code != http.StatusCreated {
		t.Fatalf("start: %d %s", code, raw)
	}
	if code, _, raw := h.verifyTrial(co.SubscriptionID, "pay_auth_185"); code != http.StatusOK {
		t.Fatalf("verify: %d %s", code, raw)
	}
	h.logout()
	// Buyer: an unpaid one-time order, written back to a Starter order for ₹3,999 a month.
	buyer := h.signup("Old Starter Order", "retire-order@example.com", true)
	order := h.buy("professional", billing.Monthly, billing.INR)
	h.logout()
	// Off: Google Drive turned off for the subscriber stays off and is not made an override.
	h.exec(store.AllowStarterSQL)
	h.exec(`INSERT INTO plan_features (plan, feature, enabled) VALUES
		('starter', 'whiteboard', true), ('starter', 'meetings', true), ('starter', 'captions', true),
		('starter', 'audience_insights', true), ('starter', 'stream_out', true),
		('starter', 'google_drive', true), ('starter', 'csv_export', true)
		ON CONFLICT (plan, feature) DO UPDATE SET enabled = true`)
	h.exec(`INSERT INTO plan_limits (plan, limit_key, value) VALUES
		('starter', 'recording_storage_bytes', 10::bigint * 1024 * 1024 * 1024)
		ON CONFLICT (plan, limit_key) DO UPDATE SET value = EXCLUDED.value`)
	h.exec(`UPDATE subscriptions SET plan = 'starter' WHERE user_id = '` + sub.ID + `'`)
	h.exec(`UPDATE billing_subscriptions SET plan = 'starter' WHERE user_id = '` + sub.ID + `'`)
	h.exec(`UPDATE billing_orders SET plan = 'starter', amount = 4_718_82, tax = 719_82 WHERE razorpay_order_id = '` + order.OrderID + `'`)
	forceFeature(t, h, sub.ID, types.FeatureGoogleDrive, false)
	if u, _ := h.store.UserByID(ctx, sub.ID); u.Plan != "starter" {
		t.Fatalf("old shape: subscriber on %q, want starter", u.Plan)
	}

	if err := h.store.ConvertRetireStarter(ctx); err != nil {
		t.Fatal(err)
	}

	u, err := h.store.UserByID(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if u.Plan != types.PlanProfessional || types.PlanAttendeeCap(u.Plan) < 200 || types.PlanStageCap(u.Plan) < 3 {
		t.Fatalf("after 0185: plan %q (%d attendees, %d on stage), want professional and no less than Starter",
			u.Plan, types.PlanAttendeeCap(u.Plan), types.PlanStageCap(u.Plan))
	}
	for _, k := range []string{types.FeatureCaptions, types.FeatureAudienceInsights, types.FeatureStreamOut, types.FeatureCSVExport} {
		if !u.HasFeature(k) {
			t.Errorf("the moved subscriber lost %s: %v", k, u.Features)
		}
	}
	if u.HasFeature(types.FeatureGoogleDrive) {
		t.Error("google_drive was off for the subscriber and came back")
	}
	var own []string
	if err := h.store.Pool().QueryRow(ctx, `SELECT features FROM users WHERE id = $1::uuid`, sub.ID).Scan(&own); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(own, types.FeatureCaptions) || slices.Contains(own, types.FeatureCSVExport) {
		t.Errorf("own overrides = %v, want captions (Starter's, not Professional's) and not csv_export (Professional's)", own)
	}
	var left int
	if err := h.store.Pool().QueryRow(ctx, `SELECT
		(SELECT count(*) FROM subscriptions WHERE plan = 'starter') +
		(SELECT count(*) FROM billing_orders WHERE plan = 'starter') +
		(SELECT count(*) FROM billing_subscriptions WHERE plan = 'starter') +
		(SELECT count(*) FROM plan_features WHERE plan = 'starter') +
		(SELECT count(*) FROM plan_limits WHERE plan = 'starter')`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("starter rows left after 0185: %d (err %v)", left, err)
	}
	if _, err := h.store.Pool().Exec(ctx, `INSERT INTO plan_features (plan, feature, enabled) VALUES ('starter', 'zoom', true)`); err == nil {
		t.Fatal("the CHECK still allows a starter tier")
	}

	// The ₹3,999 subscription renews: the charge is matched by subscription id, not price.
	h.login("retire-sub@example.com")
	periodEnd := time.Now().Add(30 * 24 * time.Hour).Unix()
	h.subWebhook("subscription.charged", co.SubscriptionID, "active", periodEnd,
		`{"id":"pay_starter_renew","amount":471882,"currency":"INR","status":"captured","method":"upi","vpa":"old@okaxis"}`)
	if st := h.myBilling(); st.Status != "active" || st.Plan != "professional" || st.PaidUntil == "" {
		t.Fatalf("after the ₹3,999 renewal: %+v, want active on professional", st)
	}
	if a := h.me(); a.Plan != types.PlanProfessional || a.AttendeeCap != types.PlanAttendeeCap(types.PlanProfessional) {
		t.Fatalf("after the ₹3,999 renewal: plan %q cap %d", a.Plan, a.AttendeeCap)
	}
	h.logout()

	// The unpaid ₹3,999 order is paid: checked against its own amount, so it fulfils.
	if res := h.webhook("payment.captured", order.OrderID, "pay_starter_order", 4_718_82, "INR"); res.StatusCode != http.StatusOK {
		t.Fatalf("order webhook: %d", res.StatusCode)
	}
	if b, err := h.store.UserByID(ctx, buyer.ID); err != nil || b.Plan != types.PlanProfessional {
		t.Fatalf("the ₹3,999 order did not fulfil: plan %q (err %v)", b.Plan, err)
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

	// 0179 to 0183 predate 0185 and write 'starter' rows: replay them with it allowed, then 0185.
	h.exec(store.AllowStarterSQL)
	if err := h.store.ConvertPricingV3(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ConvertPricingGates(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ConvertAudienceInsights(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ConvertStreamOut(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ConvertRetireStarter(ctx); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		id       string
		plan     types.Plan
		has, not []string
	}{
		// The old Professional was Starter until 0185 and is Professional now: captions kept as
		// their override, instant webinars gone with the tier (per host only).
		{pro.ID, types.PlanProfessional, []string{types.FeatureCaptions}, []string{types.FeatureInstantWebinar, types.FeatureZoom}},
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
		if want, ok := capsBefore[c.id]; ok && types.PlanAttendeeCap(u.Plan) < want {
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
