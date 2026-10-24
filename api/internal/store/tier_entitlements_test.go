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
	// Every switch no plan may include is taken out of the tiers, and nothing else is.
	for _, f := range types.Features {
		if in := strings.Contains(AIDefaultOffSQL, "'"+f.Key+"'"); in != f.PerHost {
			t.Errorf("%s: in AIDefaultOffSQL = %v, PerHost = %v", f.Key, in, f.PerHost)
		}
	}
}
