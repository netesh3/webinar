package crmstore

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestTierPredicateOnlyWritesKnownTiers(t *testing.T) {
	if got := tierPredicate(nil); got != "" {
		t.Fatalf("no tiers should add nothing, got %q", got)
	}
	got := tierPredicate([]types.EngagementTier{types.TierHigh, "x'); DROP TABLE users; --", types.TierRisk})
	if !strings.Contains(got, `es.tier IN ('high', 'risk')`) {
		t.Fatalf("predicate %q", got)
	}
	if strings.Contains(got, "DROP") || strings.Contains(got, "$") {
		t.Fatalf("unknown input reached the SQL or added a placeholder: %q", got)
	}
	if got := tierPredicate([]types.EngagementTier{types.TierNoShow}); got != "" {
		t.Fatalf("no_show is attendance, not a score tier: %q", got)
	}
}

func TestSegmentLabelNamesTiers(t *testing.T) {
	got := SegmentLabel(types.CRMSegment{Attendance: types.SegmentJoined,
		Tiers: []types.EngagementTier{types.TierHigh, types.TierEngaged}})
	if got != "Attended · Highly engaged or Engaged" {
		t.Fatalf("label %q", got)
	}
	if !strings.Contains(segmentPredicate(types.CRMSegment{Tiers: []types.EngagementTier{types.TierPassive}}), "engagement_scores") {
		t.Fatal("segment predicate ignores tiers")
	}
}
