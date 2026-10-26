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
	if acct := setPlan(types.PlanEnterprise, http.StatusOK); acct.Plan != types.PlanEnterprise || acct.AttendeeCap != 500 {
		t.Fatalf("after enterprise: plan %q cap %d", acct.Plan, acct.AttendeeCap)
	}

	h.login("plan-coach@test.dev")
	in := cloudInput(wb.Topic, wb.StartsAt, false)
	in.AttendeeLimit = 500
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("raise limit: status %d body %s", res.StatusCode, raw)
	}
	var raised types.Webinar
	h.decode(raw, &raised)
	// Enterprise allows 500, but no webinar admits more than one video box serves.
	if raised.AttendeeLimit != types.MaxWebinarAudience {
		t.Fatalf("attendeeLimit on enterprise = %d, want %d", raised.AttendeeLimit, types.MaxWebinarAudience)
	}

	// Downgraded after scheduling: the stored 300 no longer admits 300.
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
	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join", types.JoinRequest{JoinKey: reg.JoinKey})
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
