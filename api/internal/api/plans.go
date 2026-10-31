package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* attendeeCeiling is the most attendees a plan's webinars admit: the plan's cap, never
 * above the server's MAX_ATTENDEES. (31 Oct 2026) No longer also under a flat 300 per webinar
 * (types.MaxWebinarAudience, 25 Oct 2026): the plans now sell 500 (Business) and 1,000
 * (Enterprise), so the plan cap is the ceiling. A webinar's own attendee_limit sits under this; it is applied
 * when the webinar is saved and again at join, so a downgrade takes effect on webinars already
 * scheduled. An admin's per-webinar override replaces it (store.ExpectedAudience). */
func (s *Server) attendeeCeiling(plan types.Plan) int {
	return min(s.cfg.MaxAttendees, types.PlanAttendeeCap(plan))
}

// audienceLimit is the webinar's attendee limit as it applies now (store.ExpectedAudience).
func (s *Server) audienceLimit(ctx context.Context, wb types.Webinar) int {
	return store.ExpectedAudience(wb, s.ceilingForHost(ctx, wb.Host.ID))
}

// ceilingForHost reads the host's plan. A failed read is the launch default rather
// than the server's ceiling, so an outage never admits more than a plan allows.
func (s *Server) ceilingForHost(ctx context.Context, hostID string) int {
	plan, err := s.store.PlanForUser(ctx, hostID)
	if err != nil {
		s.log.Warn("attendee ceiling: could not read plan", "host", hostID, "error", err)
		plan = ""
	}
	return s.attendeeCeiling(plan)
}

/* handleSetUserPlan is PATCH /api/admin/users/{id}/plan.
 *
 * Assigns a paid plan until checkout exists; an empty plan removes it. */
func (s *Server) handleSetUserPlan(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetUserPlanRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.Plan != "" && !body.Plan.Valid() {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_plan",
			"Plan is "+types.PlanIDsText+".")
		return
	}
	updated, err := s.store.SetUserPlan(r.Context(), targetID, body.Plan)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set user plan", err)
		return
	}
	s.log.Info("user plan changed", "admin", admin.ID, "target", updated.ID, "plan", updated.Plan)
	httpx.JSON(w, http.StatusOK, updated.Public())
}
