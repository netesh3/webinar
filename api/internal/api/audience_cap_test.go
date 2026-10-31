package api_test

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// ExpectedAudience: the webinar's own limit under its ceiling, an admin's override replacing
// the ceiling, never below one.
func TestExpectedAudience(t *testing.T) {
	for _, tc := range []struct {
		name            string
		limit, override int
		ceiling, want   int
	}{
		{"under the ceiling", 50, 0, 300, 50},
		{"clamped to the ceiling", 500, 0, 300, 300},
		{"a downgraded plan", 300, 0, 200, 200},
		{"an override replaces the ceiling", 800, 800, 300, 800},
		{"the host's own limit under an override", 400, 800, 300, 400},
		{"an override below the usual ceiling", 300, 120, 300, 120},
		{"no limit is the ceiling", 0, 0, 300, 300},
		{"never zero", 0, 0, 0, 1},
	} {
		got := store.ExpectedAudience(types.Webinar{AttendeeLimit: tc.limit, AudienceCapOverride: tc.override}, tc.ceiling)
		if got != tc.want {
			t.Errorf("%s: ExpectedAudience(limit %d, override %d, ceiling %d) = %d, want %d",
				tc.name, tc.limit, tc.override, tc.ceiling, got, tc.want)
		}
	}
}

/* A webinar admits 50 unless the host chooses otherwise, never more than its plan's cap under
 * MAX_ATTENDEES (500 in tests), and an admin can set one webinar's ceiling up to 1000, which
 * the host may then use. */
func TestWebinarAudienceCap(t *testing.T) {
	h := newHarness(t)
	coach := h.signup("Seats Coach", "seats-coach@test.dev", true)
	// Nothing said about seats: the default, not the ceiling.
	if wb := h.newWebinar("Default seats", func(in *types.WebinarInput) { in.AttendeeLimit = 0 }); wb.AttendeeLimit != 50 {
		t.Fatalf("attendeeLimit by default = %d, want 50", wb.AttendeeLimit)
	}

	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	if res, raw := h.do(http.MethodPatch, "/api/admin/users/"+coach.ID+"/plan", types.SetUserPlanRequest{Plan: types.PlanEnterprise}); res.StatusCode != http.StatusOK {
		t.Fatalf("set enterprise: %d %s", res.StatusCode, raw)
	}

	h.login("seats-coach@test.dev")
	big := h.newWebinar("Big room", func(in *types.WebinarInput) { in.AttendeeLimit = 900 })
	if big.AttendeeLimit != 500 {
		t.Fatalf("attendeeLimit asked 900 on enterprise = %d, want MAX_ATTENDEES's 500", big.AttendeeLimit)
	}

	// Only an admin sets the override.
	cap800 := 800
	path := "/api/admin/webinars/" + big.ID + "/audience-cap"
	if res, _ := h.do(http.MethodPatch, path, types.SetAudienceCapRequest{AudienceCap: &cap800}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("host sets the override: status %d, want 403", res.StatusCode)
	}
	h.login("neeraj@acme.dev")
	tooMany := types.MaxAudienceOverride + 1
	if res, raw := h.do(http.MethodPatch, path, types.SetAudienceCapRequest{AudienceCap: &tooMany}); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("override %d: status %d body %s, want 422", tooMany, res.StatusCode, raw)
	}
	res, raw := h.do(http.MethodPatch, path, types.SetAudienceCapRequest{AudienceCap: &cap800})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("override 800: status %d body %s", res.StatusCode, raw)
	}
	var raised types.Webinar
	h.decode(raw, &raised)
	if raised.AudienceCapOverride != 800 || raised.AttendeeLimit != 800 {
		t.Fatalf("after override: override %d limit %d, want 800 and 800", raised.AudienceCapOverride, raised.AttendeeLimit)
	}

	// The host's own edit keeps the override's room, rather than clamping back to 300.
	h.login("seats-coach@test.dev")
	in := cloudInput(big.Topic, big.StartsAt, false)
	in.AttendeeLimit = 700
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+big.ID, in)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("host edit under the override: status %d body %s", res.StatusCode, raw)
	}
	var edited types.Webinar
	h.decode(raw, &edited)
	if edited.AttendeeLimit != 700 || edited.AudienceCapOverride != 800 {
		t.Fatalf("host edit: limit %d override %d, want 700 and 800", edited.AttendeeLimit, edited.AudienceCapOverride)
	}

	// Taken off: back under the usual ceiling.
	h.login("neeraj@acme.dev")
	res, raw = h.do(http.MethodPatch, path, types.SetAudienceCapRequest{AudienceCap: nil})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("clear override: status %d body %s", res.StatusCode, raw)
	}
	var cleared types.Webinar
	h.decode(raw, &cleared)
	if cleared.AudienceCapOverride != 0 || cleared.AttendeeLimit != 500 {
		t.Fatalf("after clearing: override %d limit %d, want 0 and 500", cleared.AudienceCapOverride, cleared.AttendeeLimit)
	}
}

/* Past the limit, a new attendee is told the webinar is full. Somebody already let in this run
 * gets back in, and so does anybody the host brought onto the stage; the host sees "N / limit"
 * from the same count; an admin raising the ceiling lets the next person in at once. */
func TestJoinTurnsAwayPastTheAttendeeLimit(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "full-house-host@test.dev")
	wb := h.liveWebinar("Full house", func(in *types.WebinarInput) {
		in.Delivery = types.DeliveryEdge
		in.AttendeeLimit = 4
	})
	regs := make([]types.Registration, 4)
	for i := range regs {
		regs[i] = h.registerAsGuest(wb.ID, uniqueEmail("seat"))
	}
	// Four registered, two seats: registrations stop at the limit, so it is lowered after.
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `UPDATE webinars SET attendee_limit = 2 WHERE slug = $1`, wb.ID); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		if res, _, raw := h.joinAsGuestKey(wb.ID, regs[i].JoinKey); res.StatusCode != http.StatusOK {
			t.Fatalf("attendee %d join: %d %s", i, res.StatusCode, raw)
		}
	}
	res, _, raw := h.joinAsGuestKey(wb.ID, regs[2].JoinKey)
	if res.StatusCode != http.StatusConflict || !strings.Contains(string(raw), "room_full") ||
		!strings.Contains(string(raw), "full (2 attendees)") {
		t.Fatalf("third attendee: %d %s, want 409 room_full naming the limit", res.StatusCode, raw)
	}

	// A reload or a reconnect keeps a seat already held.
	if res, _, raw := h.joinAsGuestKey(wb.ID, regs[0].JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin at the limit: %d %s", res.StatusCode, raw)
	}

	// Somebody the host puts on the stage is not turned away by the audience limit.
	h.promote(wb.ID, regs[3].JoinKey)
	if res, _, raw := h.joinAsGuestKey(wb.ID, regs[3].JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("promoted attendee join at the limit: %d %s", res.StatusCode, raw)
	}

	// The host's "N / limit": the two audience seats, not the promoted one.
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/edge", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("edge status: %d %s", res.StatusCode, raw)
	}
	var st types.EdgeStatus
	h.decode(raw, &st)
	if st.Audience != 2 || st.AudienceLimit != 2 {
		t.Fatalf("host sees %d / %d, want 2 / 2", st.Audience, st.AudienceLimit)
	}

	// An admin raises this webinar's ceiling: the next attendee gets in.
	promoteSeedAdmin(t, h)
	h.login("neeraj@acme.dev")
	three := 3
	if res, raw := h.do(http.MethodPatch, "/api/admin/webinars/"+wb.ID+"/audience-cap", types.SetAudienceCapRequest{AudienceCap: &three}); res.StatusCode != http.StatusOK {
		t.Fatalf("override 3: %d %s", res.StatusCode, raw)
	}
	if res, _, raw := h.joinAsGuestKey(wb.ID, regs[2].JoinKey); res.StatusCode != http.StatusOK {
		t.Fatalf("third attendee after the override: %d %s", res.StatusCode, raw)
	}
}
