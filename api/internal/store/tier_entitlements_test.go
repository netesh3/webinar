package store

import (
	"strings"
	"testing"
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
