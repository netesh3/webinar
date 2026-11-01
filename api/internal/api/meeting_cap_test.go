package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

// Meetings by plan (1 Nov 2026): Basic 10, Professional 20, Business 100, Enterprise 300; no
// plan 10. Webinars keep their own stage caps (TestPlanStageCap).
func TestPlanMeetingCap(t *testing.T) {
	for plan, want := range map[types.Plan]int{
		"": 10, types.PlanBasic: 10, types.PlanProfessional: 20,
		types.PlanBusiness: 100, types.PlanEnterprise: 300,
	} {
		if got := types.PlanMeetingCap(plan); got != want {
			t.Errorf("PlanMeetingCap(%q) = %d, want %d", plan, got, want)
		}
	}
	if types.MaxMeetingCapOverride < types.PlanMeetingCap(types.PlanEnterprise) {
		t.Errorf("an admin cannot set a meeting as big as Enterprise's (%d < %d)", types.MaxMeetingCapOverride, types.PlanMeetingCap(types.PlanEnterprise))
	}
}

/* An admin raises one account's meetings to 50, and back to the plan. The
 * webinar stage cap is a separate setting and does not move. */
func TestAdminSetsAMeetingCapSeparateFromTheStageCap(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach Meetings", "meet@test.dev", false)
	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")

	find := func() types.AdminUser {
		t.Helper()
		res, raw := h.do(http.MethodGet, "/api/admin/users?q=meet@test.dev", nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("admin users: status %d body %s", res.StatusCode, raw)
		}
		var users []types.AdminUser
		h.decode(raw, &users)
		if len(users) != 1 {
			t.Fatalf("search returned %d rows, want 1: %s", len(users), raw)
		}
		return users[0]
	}

	u := find()
	if u.MeetingCap != nil || u.PlanMeetingSeats != 10 || u.MeetingSeats != 10 {
		t.Fatalf("before: cap %v plan %d seats %d, want nil/10/10", u.MeetingCap, u.PlanMeetingSeats, u.MeetingSeats)
	}
	stageBefore := u.StageSeats

	for _, bad := range []int{0, types.MaxMeetingCapOverride + 1} {
		res, raw := h.do(http.MethodPatch, "/api/admin/users/"+u.ID+"/meeting-cap", map[string]any{"meetingCap": bad})
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("meeting cap %d: status %d body %s, want 422", bad, res.StatusCode, raw)
		}
	}

	res, raw := h.do(http.MethodPatch, "/api/admin/users/"+u.ID+"/meeting-cap", map[string]any{"meetingCap": 50})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("set 50: status %d body %s", res.StatusCode, raw)
	}
	u = find()
	if u.MeetingCap == nil || *u.MeetingCap != 50 || u.MeetingSeats != 50 {
		t.Fatalf("after 50: cap %v seats %d", u.MeetingCap, u.MeetingSeats)
	}
	if u.StageSeats != stageBefore || u.StageCap != nil {
		t.Fatalf("the webinar stage moved with the meeting cap: %d -> %d (override %v)", stageBefore, u.StageSeats, u.StageCap)
	}

	res, raw = h.do(http.MethodPatch, "/api/admin/users/"+u.ID+"/meeting-cap", map[string]any{"meetingCap": nil})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("clear: status %d body %s", res.StatusCode, raw)
	}
	if u = find(); u.MeetingCap != nil || u.MeetingSeats != 10 {
		t.Fatalf("after clear: cap %v seats %d, want nil/10", u.MeetingCap, u.MeetingSeats)
	}
}
