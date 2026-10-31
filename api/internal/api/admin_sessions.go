package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* An admin's controls over any session on the instance — webinars, meetings and simulives
 * alike (a meeting is a webinar row with kind=meeting): end one that is live, move one
 * between draft and scheduled, and delete one (handleAdminDeleteWebinar in admin.go).
 *
 * None of these is a second copy of what the host's buttons do. End is endWebinarSession,
 * the same path the host's End, the sweepers and Zoom's webhook take, so the recordings,
 * attendance, report, recap and follow-ups come out exactly as if the host had ended it.
 * Delete is deleteWebinarBySlug. Each is logged as an "admin action" line. */

// logAdminAction is the audit line every admin session control writes: who, what, which.
func (s *Server) logAdminAction(adminID, action, slug string, args ...any) {
	s.log.Info("admin action",
		append([]any{"admin", adminID, "action", action, "slug", slug}, args...)...)
}

/* handleAdminEndWebinar is POST /api/admin/webinars/{slug}/end: end a live session now.
 *
 * Only a live one. A scheduled or draft session has nothing running to end — the admin
 * wants Delete, or Change status — and ending it would mark a session that never ran as
 * over. Already ended answers with the row, so a double press is not an error. A Zoom
 * session ends in Zoom, as it does for the host. */
func (s *Server) handleAdminEndWebinar(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin end webinar", err)
		return
	}
	switch {
	case wb.Status == types.StatusEnded:
		httpx.JSON(w, http.StatusOK, wb)
		return
	case wb.Status != types.StatusLive:
		httpx.Error(w, http.StatusConflict, "not_live",
			"This session isn't live, so there is nothing to end. Delete it or change its status instead.")
		return
	case zoom.IsVenue(wb.Venue):
		httpx.Error(w, http.StatusConflict, "ends_in_zoom",
			"This session runs in Zoom and ends there. It is marked ended when Zoom says the meeting is over.")
		return
	}

	ended, err := s.endWebinarSession(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin end webinar", err)
		return
	}
	// What the host's simulive End clears too (handleSimuliveEnd).
	if wb.Kind == types.KindSimulive {
		simuliveEndCache.Delete(slug)
		replayPollCache.Delete(slug)
	}
	s.logAdminAction(admin.ID, "end", slug, "kind", wb.Kind)
	httpx.JSON(w, http.StatusOK, ended)
}

/* handleAdminSetWebinarStatus is PATCH /api/admin/webinars/{slug}/status {status}.
 *
 * Draft and scheduled, either way: publish a draft, or take a scheduled session back to a
 * draft so the public page stops showing it. Everything else is refused with 409 and a
 * reason. Live is never set from here — going live needs the host in the room — and live
 * to ended is End, above. An ended session stays ended: reopening one would put a session
 * whose report, recordings and recap are already final back on the schedule. */
func (s *Server) handleAdminSetWebinarStatus(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")

	var body types.AdminWebinarStatus
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	switch body.Status {
	case types.StatusDraft, types.StatusScheduled:
	case types.StatusLive:
		httpx.Error(w, http.StatusConflict, "bad_transition",
			"A session goes live when its host starts it from the room. An admin can't make it live.")
		return
	case types.StatusEnded:
		httpx.Error(w, http.StatusConflict, "bad_transition",
			"Use End to end a live session.")
		return
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_status",
			"status must be draft or scheduled.")
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin set webinar status", err)
		return
	}
	switch wb.Status {
	case body.Status:
		httpx.JSON(w, http.StatusOK, wb)
		return
	case types.StatusLive:
		httpx.Error(w, http.StatusConflict, "bad_transition",
			"This session is live. End it first.")
		return
	case types.StatusEnded:
		httpx.Error(w, http.StatusConflict, "bad_transition",
			"This session has ended. An ended session can't be reopened.")
		return
	}

	updated, err := s.store.SetPlannedStatus(r.Context(), slug, wb.Status, body.Status)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	case errors.Is(err, store.ErrConflict):
		httpx.Error(w, http.StatusConflict, "bad_transition",
			"This session changed while you were looking at it. Reload and try again.")
		return
	case err != nil:
		s.fail(w, r, "admin set webinar status", err)
		return
	}
	s.logAdminAction(admin.ID, "set_status", slug, "from", wb.Status, "to", updated.Status)
	httpx.JSON(w, http.StatusOK, updated)
}

/* handleAdminSetAudienceCap is PATCH /api/admin/webinars/{slug}/audience-cap: an admin's
 * ceiling for one webinar's audience, in place of the usual one (the plan's cap under MAX_ATTENDEES).
 *
 * A number (1..MaxAudienceOverride) is also the webinar's attendee limit from then on: an admin
 * raising a webinar to 800 means 800 seats, not permission the host has to notice and use. Null
 * takes the override off and brings the limit back under the usual ceiling. Not for meetings,
 * which have their own cap (PATCH /api/admin/users/{id}/meeting-cap). The join check reads the
 * new number on the next join; a webinar already live does not need restarting. */
func (s *Server) handleAdminSetAudienceCap(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")
	var body types.SetAudienceCapRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		return
	}
	if body.AudienceCap != nil && (*body.AudienceCap < 1 || *body.AudienceCap > types.MaxAudienceOverride) {
		httpx.Fields(w, map[string]string{
			"audienceCap": fmt.Sprintf("Between 1 and %d, or empty to use the usual ceiling.", types.MaxAudienceOverride),
		})
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin audience cap", err)
		return
	}
	if wb.Kind == types.KindMeeting {
		httpx.Error(w, http.StatusConflict, "meeting",
			"A meeting's size is set by its host's meeting cap, not here.")
		return
	}
	limit := 0
	if body.AudienceCap != nil {
		limit = *body.AudienceCap
	} else {
		limit = min(wb.AttendeeLimit, s.ceilingForHost(r.Context(), wb.Host.ID))
	}
	updated, err := s.store.SetAudienceCap(r.Context(), slug, body.AudienceCap, limit)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin audience cap", err)
		return
	}
	s.logAdminAction(admin.ID, "audience_cap", slug, "cap", updated.AudienceCapOverride, "limit", updated.AttendeeLimit)
	httpx.JSON(w, http.StatusOK, updated)
}
