package api

import (
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/netkumar/webcast/api/types"
)

func TestPlanStageCap(t *testing.T) {
	for plan, want := range map[types.Plan]int{
		// 31 Oct 2026: Basic 3, Professional 5, Business 10, Enterprise 100; Starter keeps 3.
		"": 3, types.PlanBasic: 3, types.PlanStarter: 3, types.PlanProfessional: 5,
		types.PlanBusiness: 10, types.PlanEnterprise: 100,
	} {
		if got := types.PlanStageCap(plan); got != want {
			t.Errorf("PlanStageCap(%q) = %d, want %d", plan, got, want)
		}
	}
}

func TestStageCountCountsEveryPublisherButThePersonBeingAdded(t *testing.T) {
	parts := []types.LiveParticipant{
		{Identity: "user_host", Role: types.RoleHost},
		{Identity: "user_panel", Role: types.RolePanelist},
		{Identity: "att_speaker", Role: types.RoleAttendee, CanSpeak: true}, // allowed to speak
		{Identity: "att_watcher", Role: types.RoleAttendee},
	}
	if got := stageCount(parts, ""); got != 3 {
		t.Errorf("stageCount = %d, want 3 (host, panelist, speaking attendee)", got)
	}
	// A reconnecting panelist is not counted against their own seat.
	if got := stageCount(parts, "user_panel"); got != 2 {
		t.Errorf("stageCount except the panelist = %d, want 2", got)
	}
}

func TestPanelistCapCountsTheHostAndDistinctEmails(t *testing.T) {
	// Cap 3: the host plus two panelists fit; a third does not.
	if msg := panelistCapField([]string{"a@x.com", "b@x.com"}, 3); msg != "" {
		t.Errorf("two panelists on a 3-seat stage refused: %q", msg)
	}
	if msg := panelistCapField([]string{"a@x.com", "b@x.com", "c@x.com"}, 3); msg == "" {
		t.Error("three panelists on a 3-seat stage accepted")
	}
	// Duplicates and blanks are not extra people.
	if msg := panelistCapField([]string{"a@x.com", " A@x.com ", "", "b@x.com"}, 3); msg != "" {
		t.Errorf("duplicates counted twice: %q", msg)
	}
}

func TestEgressStuckStartingIsTreatedAsGone(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	fresh := &livekit.EgressInfo{StartedAt: now.Add(-30 * time.Second).UnixNano()}
	stuck := &livekit.EgressInfo{StartedAt: now.Add(-3 * time.Minute).UnixNano()}
	if egressStartingTooLong(fresh, now) {
		t.Error("a 30s-old start (worker still booting) was treated as dead")
	}
	if !egressStartingTooLong(stuck, now) {
		t.Error("a start stuck for 3 minutes was still counted as running")
	}
	if egressStartingTooLong(&livekit.EgressInfo{}, now) {
		t.Error("an egress with no timestamps was treated as dead")
	}
}
