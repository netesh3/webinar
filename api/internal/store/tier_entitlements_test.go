package store

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestFeatureOverrideConversionSQLMatchesMigration(t *testing.T) {
	body, err := migrationFS.ReadFile("migrations/0107_tier_entitlements.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), FeatureOverrideConversionSQL) {
		t.Fatalf("0107 drifted from FeatureOverrideConversionSQL:\n%s", body)
	}
}

func TestAIDefaultOffSQLMatchesMigration(t *testing.T) {
	body, err := migrationFS.ReadFile("migrations/0159_ai_default_off.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), AIDefaultOffSQL) {
		t.Fatalf("0159 drifted from AIDefaultOffSQL:\n%s", body)
	}
	// 0159 took the AI-backed switches out of the tiers, and nothing else. (Since 0179 most of
	// them are back in Business and up, so PerHost no longer says which they were.)
	for _, f := range types.Features {
		want := f.Group == types.FeatureGroupAI || f.Key == types.FeatureClips
		if in := strings.Contains(AIDefaultOffSQL, "'"+f.Key+"'"); in != want {
			t.Errorf("%s: in AIDefaultOffSQL = %v, want %v", f.Key, in, want)
		}
	}
}

func TestPricingGatesSQLMatchesMigration(t *testing.T) {
	body, err := migrationFS.ReadFile("migrations/0180_pricing_gates.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), PricingGatesSQL) {
		t.Fatalf("0180 drifted from PricingGatesSQL:\n%s", body)
	}
	// TierFeatures says what 0180 sets: captions Business and up, cloud recording Professional up.
	has := func(plan types.Plan, key string) bool {
		for _, k := range TierFeatures[plan] {
			if k == key {
				return true
			}
		}
		return false
	}
	for plan, row := range map[types.Plan][2]bool{
		types.PlanBasic: {false, false}, types.PlanProfessional: {false, true},
		types.PlanBusiness: {true, true}, types.PlanEnterprise: {true, true},
	} {
		if has(plan, types.FeatureCaptions) != row[0] || has(plan, types.FeatureCloudRecording) != row[1] {
			t.Errorf("%s: captions %v cloud_recording %v, want %v", plan,
				has(plan, types.FeatureCaptions), has(plan, types.FeatureCloudRecording), row)
		}
		want := "('" + string(plan) + "', "
		if !strings.Contains(PricingGatesSQL, want) {
			t.Errorf("PricingGatesSQL has no row for %s", plan)
		}
	}
}

func TestPricingV3SQLMatchesMigration(t *testing.T) {
	body, err := migrationFS.ReadFile("migrations/0179_pricing_v3.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), PricingV3SQL) {
		t.Fatalf("0179 drifted from PricingV3SQL:\n%s", body)
	}
	// The SQL's tiers are TierFeatures: every tiered switch is named, and every plan on sale.
	for _, k := range PricingV3Features {
		if !strings.Contains(PricingV3SQL, "'"+k+"'") {
			t.Errorf("PricingV3SQL does not set %s", k)
		}
	}
	for plan := range TierFeatures {
		if !strings.Contains(PricingV3SQL, "('"+string(plan)+"',") {
			t.Errorf("PricingV3SQL has no row for %s", plan)
		}
	}
	// No per-host switch is a tier's.
	for _, f := range types.Features {
		if !f.PerHost {
			continue
		}
		for plan, keys := range TierFeatures {
			for _, k := range keys {
				if k == f.Key {
					t.Errorf("%s includes %s, which is per host only", plan, k)
				}
			}
		}
	}
}
