package api_test

import (
	"net/http"
	"slices"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* Moving to "plan, then overrides" changes nobody's features. Rows are written in the
 * old shape — every switch on the account, whiteboard included by default — and the
 * migration's own conversion is applied to them. */
func TestFeatureConversionKeepsEveryonesFeatures(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	cases := map[string][]string{
		"conv-default@test.dev":  {types.FeatureWhiteboard},
		"conv-off@test.dev":      {},
		"conv-extra@test.dev":    {types.FeatureWhiteboard, types.FeatureZoom},
		"conv-extra-no@test.dev": {types.FeatureCloudRecording},
	}
	ids := map[string]string{}
	for email, old := range cases {
		acct := h.signup("Conv", email, true)
		ids[email] = acct.ID
		if _, err := h.store.Pool().Exec(ctx,
			`UPDATE users SET features = $2, features_off = '{}' WHERE id = $1::uuid`, acct.ID, old); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.store.ConvertFeatureOverrides(ctx); err != nil {
		t.Fatal(err)
	}
	for email, old := range cases {
		u, err := h.store.UserByID(ctx, ids[email])
		if err != nil {
			t.Fatal(err)
		}
		want := slices.Clone(old)
		slices.Sort(want)
		if !slices.Equal(u.Features, want) {
			t.Errorf("%s: features after conversion = %v, want %v", email, u.Features, want)
		}
	}
}

func adminPlanFeatures(t *testing.T, h *harness, method string, body any, want int) types.PlanFeaturesBody {
	t.Helper()
	res, raw := h.do(method, "/api/admin/plan-features", body)
	if res.StatusCode != want {
		t.Fatalf("%s plan-features: status %d body %s, want %d", method, res.StatusCode, raw, want)
	}
	var out types.PlanFeaturesBody
	if want == http.StatusOK {
		h.decode(raw, &out)
	}
	return out
}

/* A tier grants and revokes for everyone on it without an override; an override on
 * or off beats the tier; clearing the override inherits again. */
func TestPlanDecidesFeaturesAndOverridesWin(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	pro := h.signup("Pro Host", "tier-pro@test.dev", true)
	none := h.signup("Free Host", "tier-none@test.dev", true)
	if _, err := h.store.SetUserPlan(ctx, pro.ID, types.PlanProfessional); err != nil {
		t.Fatal(err)
	}

	original, err := h.store.PlanFeatures(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.store.SetPlanFeatures(t.Context(), original) })

	// Anonymous and non-admin callers are refused.
	h.logout()
	adminPlanFeatures(t, h, http.MethodGet, nil, http.StatusUnauthorized)
	h.login("tier-pro@test.dev")
	adminPlanFeatures(t, h, http.MethodGet, nil, http.StatusForbidden)
	adminPlanFeatures(t, h, http.MethodPut, types.PlanFeaturesBody{}, http.StatusForbidden)

	if _, _, err := h.store.PromoteAdmins(ctx, []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	got := adminPlanFeatures(t, h, http.MethodGet, nil, http.StatusOK)
	if len(got.Tiers) != 4 || got.Tiers[0].Plan != "" || !slices.Contains(got.Tiers[0].Features, types.FeatureWhiteboard) {
		t.Fatalf("seeded matrix = %+v, want four tiers starting with no plan, whiteboard on", got.Tiers)
	}

	adminPlanFeatures(t, h, http.MethodPut, types.PlanFeaturesBody{Tiers: []types.PlanFeatures{
		{Plan: "platinum", Features: []string{}},
	}}, http.StatusUnprocessableEntity)
	adminPlanFeatures(t, h, http.MethodPut, types.PlanFeaturesBody{Tiers: []types.PlanFeatures{
		{Plan: types.PlanProfessional, Features: []string{"telepathy"}},
	}}, http.StatusUnprocessableEntity)

	// Professional gains Zoom; no plan does not.
	matrix := []types.PlanFeatures{
		{Plan: "", Features: []string{types.FeatureWhiteboard}},
		{Plan: types.PlanProfessional, Features: []string{types.FeatureWhiteboard, types.FeatureZoom}},
		{Plan: types.PlanBusiness, Features: []string{types.FeatureWhiteboard}},
		{Plan: types.PlanEnterprise, Features: []string{types.FeatureWhiteboard}},
	}
	adminPlanFeatures(t, h, http.MethodPut, types.PlanFeaturesBody{Tiers: matrix}, http.StatusOK)
	has := func(id, feature string) bool {
		t.Helper()
		u, err := h.store.UserByID(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return u.HasFeature(feature)
	}
	if !has(pro.ID, types.FeatureZoom) || has(none.ID, types.FeatureZoom) {
		t.Fatalf("after granting Zoom to professional: pro %v, none %v", has(pro.ID, types.FeatureZoom), has(none.ID, types.FeatureZoom))
	}

	setOverride := func(id string, grant types.FeatureGrant) {
		t.Helper()
		res, raw := h.do(http.MethodPatch, "/api/admin/users/"+id+"/features", grant)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("override %+v: status %d body %s", grant, res.StatusCode, raw)
		}
	}
	// Off beats the tier, on beats the tier, inherit goes back to the tier.
	setOverride(pro.ID, types.FeatureGrant{Feature: types.FeatureZoom, Enabled: false})
	setOverride(none.ID, types.FeatureGrant{Feature: types.FeatureZoom, Enabled: true})
	if has(pro.ID, types.FeatureZoom) || !has(none.ID, types.FeatureZoom) {
		t.Fatal("overrides did not beat the tier")
	}
	res, raw := h.do(http.MethodGet, "/api/admin/users?q=tier-", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin users: %d %s", res.StatusCode, raw)
	}
	var users []types.AdminUser
	h.decode(raw, &users)
	for _, u := range users {
		want := u.ID == none.ID
		if v, ok := u.FeatureOverrides[types.FeatureZoom]; !ok || v != want {
			t.Errorf("%s featureOverrides = %v, want zoom=%v", u.Email, u.FeatureOverrides, want)
		}
	}
	setOverride(pro.ID, types.FeatureGrant{Feature: types.FeatureZoom, Inherit: true})
	setOverride(none.ID, types.FeatureGrant{Feature: types.FeatureZoom, Inherit: true})
	if !has(pro.ID, types.FeatureZoom) || has(none.ID, types.FeatureZoom) {
		t.Fatal("clearing the override did not inherit the tier")
	}

	// Taking Zoom off the tier revokes it for everyone on it without an override.
	matrix[1].Features = []string{types.FeatureWhiteboard}
	adminPlanFeatures(t, h, http.MethodPut, types.PlanFeaturesBody{Tiers: matrix}, http.StatusOK)
	if has(pro.ID, types.FeatureZoom) {
		t.Fatal("removing Zoom from professional left it on")
	}
}
