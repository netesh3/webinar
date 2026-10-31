package api_test

import (
	"net/http"
	"testing"

	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* The plan is the attendee ceiling. No plan is the launch cap; an admin assigns
 * one until checkout exists; the cap clamps a webinar when it is saved and again
 * at join, so a downgrade reaches webinars already scheduled. */
func TestPlanSetsTheAttendeeCeiling(t *testing.T) {
	h := newHarness(t)
	coach := h.signup("Plan Coach", "plan-coach@test.dev", true)
	if coach.Plan != "" || coach.AttendeeCap != types.PlanLaunchAttendees {
		t.Fatalf("new host plan = %q cap %d, want none and %d", coach.Plan, coach.AttendeeCap, types.PlanLaunchAttendees)
	}
	wb := h.newWebinar("Launch cap", func(in *types.WebinarInput) { in.AttendeeLimit = 500 })
	if wb.AttendeeLimit != types.PlanLaunchAttendees {
		t.Fatalf("attendeeLimit with no plan = %d, want %d", wb.AttendeeLimit, types.PlanLaunchAttendees)
	}

	if _, _, err := h.store.PromoteAdmins(t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		t.Fatal(err)
	}
	h.login("neeraj@acme.dev")
	setPlan := func(plan types.Plan, want int) types.Account {
		t.Helper()
		res, raw := h.do(http.MethodPatch, "/api/admin/users/"+coach.ID+"/plan", types.SetUserPlanRequest{Plan: plan})
		if res.StatusCode != want {
			t.Fatalf("set plan %q: status %d body %s, want %d", plan, res.StatusCode, raw, want)
		}
		var acct types.Account
		h.decode(raw, &acct)
		return acct
	}
	setPlan("platinum", http.StatusUnprocessableEntity)
	// Every plan id an admin may assign, the grandfathered Starter included.
	for _, p := range []types.Plan{types.PlanBasic, types.PlanStarter, types.PlanProfessional, types.PlanBusiness, types.PlanEnterprise} {
		if acct := setPlan(p, http.StatusOK); acct.Plan != p || acct.AttendeeCap != types.PlanAttendeeCap(p) {
			t.Fatalf("admin sets %s: plan %q cap %d", p, acct.Plan, acct.AttendeeCap)
		}
	}
	h.login("plan-coach@test.dev")

	/* (31 Oct 2026) Each plan's cap is its webinars' ceiling, under MAX_ATTENDEES (500 in
	 * the test config): Basic 100, Starter 200, Professional 300, Business 500, Enterprise
	 * 1,000 (so 500 here). No flat 300 per webinar any more. */
	in := cloudInput(wb.Topic, wb.StartsAt, false)
	var raised types.Webinar
	for _, c := range []struct {
		plan       types.Plan
		cap, limit int
	}{
		{types.PlanBasic, 100, 100},
		{types.PlanStarter, 200, 200},
		{types.PlanProfessional, 300, 300},
		{types.PlanBusiness, 500, 500},
		{types.PlanEnterprise, 1000, 500},
	} {
		if _, err := h.store.SetUserPlan(t.Context(), coach.ID, c.plan); err != nil {
			t.Fatal(err)
		}
		if acct := h.me(); acct.Plan != c.plan || acct.AttendeeCap != c.cap {
			t.Fatalf("after %s: plan %q cap %d, want %d", c.plan, acct.Plan, acct.AttendeeCap, c.cap)
		}
		in.AttendeeLimit = 1000
		res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("raise limit on %s: status %d body %s", c.plan, res.StatusCode, raw)
		}
		h.decode(raw, &raised)
		if raised.AttendeeLimit != c.limit {
			t.Fatalf("attendeeLimit on %s = %d, want %d", c.plan, raised.AttendeeLimit, c.limit)
		}
	}

	// Downgraded after scheduling: the stored 500 no longer admits 500.
	h.login("neeraj@acme.dev")
	if acct := setPlan("", http.StatusOK); acct.Plan != "" || acct.AttendeeCap != types.PlanLaunchAttendees {
		t.Fatalf("after removing the plan: plan %q cap %d", acct.Plan, acct.AttendeeCap)
	}
	h.login("plan-coach@test.dev")
	h.goLive(wb.ID)
	reg := h.registerAs(wb.ID, "plan-attendee@test.dev")
	// The room the launch cap makes (cap plus stage headroom), already full.
	h.rooms.mu.Lock()
	h.rooms.count = types.PlanLaunchAttendees + 5
	h.rooms.mu.Unlock()
	res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("join at the launch cap after a downgrade: status %d body %s, want 409", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	size := h.rooms.created[lk.RoomName(wb.ID)]
	h.rooms.mu.Unlock()
	if size != uint32(types.PlanLaunchAttendees+5) {
		t.Errorf("room size = %d, want the launch cap plus stage headroom", size)
	}
}
