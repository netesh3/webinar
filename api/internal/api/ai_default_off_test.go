package api_test

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* AI is off by default for every host on every plan (migrations/0159): no plan tier includes
 * an AI-backed switch, a new host has none of them, and an admin's per-host grant is the only
 * way one comes on. */

// perHostKeys is every switch no plan may include: the AI-backed ones.
func perHostKeys() []string {
	var out []string
	for _, f := range types.Features {
		if f.PerHost {
			out = append(out, f.Key)
		}
	}
	return out
}

// needsAI reports whether a switch is AI or needs it, directly or through another switch.
func needsAI(key string) bool {
	if key == types.FeatureAI {
		return true
	}
	f, _ := types.FeatureByKey(key)
	return slices.ContainsFunc(f.Requires, needsAI)
}

func TestEveryAIFeatureIsPerHost(t *testing.T) {
	for _, f := range types.Features {
		// HLS delivery is the one per-host switch that is not AI (29 Oct 2026): an admin's call.
		if want := f.Group == types.FeatureGroupAI || needsAI(f.Key) || f.Key == types.FeatureHLSDelivery; f.PerHost != want {
			t.Errorf("%s: PerHost = %v, want %v (AI-backed switches and HLS delivery are per host only)", f.Key, f.PerHost, want)
		}
	}
	for _, k := range []string{types.FeatureAI, types.FeatureAIKnowledge, types.FeatureSimuliveAuto,
		types.FeatureFollowupSend, types.FeatureRepurpose, types.FeatureClips} {
		if !types.PerHostFeature(k) {
			t.Errorf("%s is not PerHost", k)
		}
	}
}

func TestNewHostsHaveNoAIOnAnyPlanUntilAnAdminGrantsIt(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()

	tiers, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range tiers {
		for _, k := range perHostKeys() {
			if slices.Contains(tier.Features, k) {
				t.Errorf("plan %q includes %s; no plan may include an AI switch", tier.Plan, k)
			}
		}
	}

	hosts := map[types.Plan]types.Account{}
	for _, plan := range store.PlanTiers {
		acct := h.signup("AI Off "+string(plan), "ai-off-"+string(plan)+"@test.dev", true)
		if plan != "" {
			if _, err := h.store.SetUserPlan(ctx, acct.ID, plan); err != nil {
				t.Fatal(err)
			}
		}
		hosts[plan] = acct
		me := meAccount(t, h)
		for _, k := range perHostKeys() {
			if hasFeature(me.Features, k) {
				t.Errorf("new host on plan %q has %s: %v", plan, k, me.Features)
			}
		}
		// And the server refuses, not only the screen: AI writing answers feature_off.
		res, raw := h.do(http.MethodPost, "/api/host/ai/webinar-setup", map[string]string{"brief": "A talk"})
		h.wantError(res, raw, http.StatusForbidden, "feature_off")
	}

	if _, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	grant := func(id string, g types.FeatureGrant) types.Account {
		t.Helper()
		res, raw := h.do(http.MethodPatch, "/api/admin/users/"+id+"/features", g)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("grant %+v: %d %s", g, res.StatusCode, raw)
		}
		var a types.Account
		h.decode(raw, &a)
		return a
	}

	// An admin turns AI on for one host: that host has it, nobody else on the plan does.
	biz := hosts[types.PlanBusiness]
	a := grant(biz.ID, types.FeatureGrant{Feature: types.FeatureAI, Enabled: true})
	if !hasFeature(a.Features, types.FeatureAI) || hasFeature(a.Features, types.FeatureAIKnowledge) {
		t.Fatalf("after granting ai: %v, want ai and no ai_knowledge (its own grant)", a.Features)
	}
	a = grant(biz.ID, types.FeatureGrant{Feature: types.FeatureAIKnowledge, Enabled: true})
	if !hasFeature(a.Features, types.FeatureAIKnowledge) {
		t.Fatalf("after granting ai_knowledge: %v", a.Features)
	}
	if u, err := h.store.UserByID(ctx, hosts[types.PlanProfessional].ID); err != nil || u.HasFeature(types.FeatureAI) {
		t.Fatalf("another host has ai after one grant (err %v)", err)
	}
	// Plan default (Inherit) is off.
	a = grant(biz.ID, types.FeatureGrant{Feature: types.FeatureAI, Inherit: true})
	if hasFeature(a.Features, types.FeatureAI) || hasFeature(a.Features, types.FeatureAIKnowledge) {
		t.Fatalf("after inherit: %v, want no AI", a.Features)
	}

	// The plan matrix refuses an AI switch in any tier, and writes nothing.
	for _, k := range perHostKeys() {
		res, raw := h.do(http.MethodPut, "/api/admin/plan-features", types.PlanFeaturesBody{Tiers: []types.PlanFeatures{
			{Plan: types.PlanEnterprise, Features: []string{types.FeatureWhiteboard, k}},
		}})
		h.wantError(res, raw, http.StatusUnprocessableEntity, "per_host_feature")
	}
	after, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.EqualFunc(after, tiers, func(a, b types.PlanFeatures) bool {
		return a.Plan == b.Plan && slices.Equal(a.Features, b.Features)
	}) {
		t.Fatalf("a refused save changed the matrix: %+v, was %+v", after, tiers)
	}
}

/* migrations/0159 on the old shape: the AI sub-switches in every tier (0142) and an admin who
 * had ticked ai in Professional. A host an admin gave ai keeps everything AI they had; one
 * who had AI only from their plan loses it; the undo puts it all back. */
func TestAIDefaultOffMigrationKeepsAdminGrants(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	original, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = h.store.Pool().Exec(bg, `DELETE FROM ai_default_off_undo`)
		if err := h.store.SetPlanFeatures(bg, original); err != nil {
			t.Errorf("restore plan features: %v", err)
		}
	})
	h.exec(`DELETE FROM ai_default_off_undo`)
	h.exec(`INSERT INTO plan_features (plan, feature, enabled)
		SELECT p, f, true
		  FROM unnest(ARRAY['', 'professional', 'business', 'enterprise']) AS p
		 CROSS JOIN unnest(ARRAY['ai_knowledge', 'simulive_auto', 'followup_send']) AS f
		ON CONFLICT (plan, feature) DO UPDATE SET enabled = true`)
	h.exec(`INSERT INTO plan_features (plan, feature, enabled) VALUES ('professional', 'ai', true)
		ON CONFLICT (plan, feature) DO UPDATE SET enabled = true`)

	granted := h.signup("Granted", "mig-granted@test.dev", true)      // business, ai by hand
	narrowed := h.signup("Narrowed", "mig-narrowed@test.dev", true)   // ai by hand, knowledge off
	planOnly := h.signup("Plan only", "mig-plan-only@test.dev", true) // professional, no override
	nobody := h.signup("Nobody", "mig-nobody@test.dev", true)         // no plan, no override
	for id, plan := range map[string]types.Plan{granted.ID: types.PlanBusiness, planOnly.ID: types.PlanProfessional} {
		if _, err := h.store.SetUserPlan(ctx, id, plan); err != nil {
			t.Fatal(err)
		}
	}
	forceFeature(t, h, granted.ID, types.FeatureAI, true)
	forceFeature(t, h, narrowed.ID, types.FeatureAI, true)
	forceFeature(t, h, narrowed.ID, types.FeatureAIKnowledge, false)

	aiOf := func(id string) []string {
		t.Helper()
		u, err := h.store.UserByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, k := range u.Features {
			if types.PerHostFeature(k) {
				out = append(out, k)
			}
		}
		slices.Sort(out)
		return out
	}
	before := map[string][]string{}
	for _, id := range []string{granted.ID, narrowed.ID, planOnly.ID, nobody.ID} {
		before[id] = aiOf(id)
	}
	if want := []string{"ai", "ai_knowledge", "followup_send"}; !slices.Equal(before[planOnly.ID], want) {
		t.Fatalf("plan-only host before = %v, want %v", before[planOnly.ID], want)
	}

	if err := h.store.ConvertAIDefaultOff(ctx); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		id   string
		want []string
	}{
		{granted.ID, before[granted.ID]}, // keeps ai, ai_knowledge, followup_send
		{narrowed.ID, before[narrowed.ID]},
		{planOnly.ID, nil}, // AI came from the plan only
		{nobody.ID, nil},
	} {
		if got := aiOf(c.id); !slices.Equal(got, c.want) {
			t.Errorf("%s after 0159 = %v, want %v", c.id, got, c.want)
		}
	}
	if !slices.Contains(before[granted.ID], types.FeatureAIKnowledge) || slices.Contains(before[narrowed.ID], types.FeatureAIKnowledge) {
		t.Fatalf("fixture: granted %v, narrowed %v", before[granted.ID], before[narrowed.ID])
	}
	tiers, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range tiers {
		for _, k := range tier.Features {
			if types.PerHostFeature(k) {
				t.Errorf("plan %q still includes %s", tier.Plan, k)
			}
		}
	}

	// The undo restores the old shape exactly.
	h.exec(store.AIDefaultOffUndoSQL)
	for id, want := range before {
		if got := aiOf(id); !slices.Equal(got, want) {
			t.Errorf("%s after undo = %v, want %v", id, got, want)
		}
	}
}
