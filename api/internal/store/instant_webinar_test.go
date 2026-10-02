package store

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestOperatorInstantWebinarSQLMatchesMigration(t *testing.T) {
	body, err := migrationFS.ReadFile("migrations/0087_instant_webinar_operator.sql")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), OperatorInstantWebinarSQL) {
		t.Fatalf("0087 drifted from OperatorInstantWebinarSQL:\n%s", body)
	}
	if !strings.Contains(OperatorInstantWebinarSQL, types.FeatureInstantWebinar) {
		t.Fatalf("backfill does not set %s", types.FeatureInstantWebinar)
	}
}
