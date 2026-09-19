package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Administration: who may host.
 *
 * Two endpoints, because there is exactly one privilege to administer. Hosting used to be
 * self-service — a checkbox at signup and a toggle on the profile form — so any visitor could
 * create webinars and start taking strangers' names, emails and phone numbers. That is now a
 * grant, and this is where it is made.
 *
 * There is no endpoint here that creates another admin. That is not an omission to be filled in
 * later: a privilege which can be granted through the API can be granted by whoever takes over
 * one admin account, and the property worth having is that the chain starts outside the
 * application. Admins come from ADMIN_EMAILS, reconciled at boot.
 */

// handleAdminUsers is GET /api/admin/users?q=…
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.AdminUsers(r.Context(), r.URL.Query().Get("q"), 200)
	if err != nil {
		s.fail(w, r, "admin users", err)
		return
	}
	httpx.JSON(w, http.StatusOK, users)
}

/* handleSetHostCapability is PATCH /api/admin/users/{id}/host.
 *
 * A PATCH with an explicit boolean rather than POST /grant and POST /revoke. The action is
 * idempotent and the UI is a switch, so a request that says what the state should BE cannot
 * double-apply if it is retried — which two verbs invite.
 */
func (s *Server) handleSetHostCapability(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.HostGrant
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	/* An admin cannot revoke their own hosting.
	 *
	 * Not paranoia about self-harm — it is the only lockout in here that cannot be undone from
	 * inside the app. An admin who turns their own hosting off has no toggle to turn it back
	 * on, because the toggle they would use is the one they just removed access to, and
	 * recovery means an operator editing the database. Refusing is cheap; the alternative is a
	 * support call.
	 */
	if targetID == admin.ID && !body.CanHost {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot_self_revoke",
			"You can't remove your own hosting access.")
		return
	}

	updated, err := s.store.SetHostCapability(r.Context(), targetID, body.CanHost)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set host capability", err)
		return
	}

	// Logged with both parties, because this is the audit trail for a privilege change and
	// "who granted this" is the first question anybody asks about one.
	s.log.Info("host capability changed",
		"admin", admin.ID, "target", updated.ID, "can_host", updated.CanHost)

	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleSetUserMaxDuration is PATCH /api/admin/users/{id}/max-duration.
 *
 * Configures an account's maximum meeting length in minutes.
 * Passing null resets the account to use the system default limit.
 */
func (s *Server) handleSetUserMaxDuration(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetUserMaxDurationRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	if body.MaxDurationMin != nil && *body.MaxDurationMin <= 0 {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid_duration",
			"Max meeting duration must be at least 1 minute or null to use the system default.")
		return
	}

	updated, err := s.store.SetUserMaxDuration(r.Context(), targetID, body.MaxDurationMin)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set user max duration", err)
		return
	}

	s.log.Info("user max duration changed",
		"admin", admin.ID, "target", updated.ID, "max_duration_min", updated.MaxDurationMin)

	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleSetCdnBroadcastCapability is PATCH /api/admin/users/{id}/cdn-broadcast.
 *
 * Configures whether an account's webinars stream to audience attendees via CDN HLS.
 */
func (s *Server) handleSetCdnBroadcastCapability(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.CdnBroadcastGrant
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	updated, err := s.store.SetCdnBroadcastCapability(r.Context(), targetID, body.CanCdnBroadcast)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set cdn broadcast capability", err)
		return
	}

	s.log.Info("cdn broadcast capability changed",
		"admin", admin.ID, "target", updated.ID, "can_cdn_broadcast", updated.CanCdnBroadcast)

	httpx.JSON(w, http.StatusOK, updated.Public())
}

/* handleAdminWebinars is GET /api/admin/webinars?status=&from=&to=&q=.
 *
 * The only place in the app that lists webinars across every host: every
 * other listing (VisibleTo, ByHost) is deliberately scoped to one account,
 * and an admin reviewing what has run — or what is coming up — on the whole
 * instance needs the one view that isn't.
 *
 * status is one of "scheduled", "live", "ended", or omitted for all three.
 * from/to are plain dates (2006-01-02), because a date picker is what an
 * admin filtering "webinars in March" actually has, not a timestamp — to is
 * read as the end of that day so the day itself is included.
 */
func (s *Server) handleAdminWebinars(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	filter := store.AdminWebinarFilter{
		Search: q.Get("q"),
	}

	switch status := types.WebinarStatus(q.Get("status")); status {
	case "", types.StatusDraft, types.StatusScheduled, types.StatusLive, types.StatusEnded:
		filter.Status = status
	default:
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_status",
			"status must be draft, scheduled, live, or ended.")
		return
	}

	if v := q.Get("from"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_from", "from must be YYYY-MM-DD.")
			return
		}
		filter.From = t
	}
	if v := q.Get("to"); v != "" {
		t, err := time.Parse("2006-01-02", v)
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_to", "to must be YYYY-MM-DD.")
			return
		}
		// End of that day, inclusive — a bare date otherwise means midnight,
		// which would exclude every webinar on the day the admin actually asked for.
		filter.To = t.Add(24*time.Hour - time.Nanosecond)
	}

	list, err := s.store.AdminWebinars(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "admin webinars", err)
		return
	}
	httpx.JSON(w, http.StatusOK, list)
}

// handleAdminDeleteWebinar is DELETE /api/admin/webinars/{slug} — the same
// teardown a host's own delete performs (see deleteWebinarBySlug), reachable
// here without owning the webinar. The one privilege this endpoint adds over
// the host one is exactly that: whose webinar it is stops mattering.
func (s *Server) handleAdminDeleteWebinar(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	slug := chi.URLParam(r, "slug")

	deleted, err := s.deleteWebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "admin delete webinar", err)
		return
	}

	s.log.Info("webinar deleted by admin", "admin", admin.ID, "slug", slug)
	s.logWebinarDeleted(slug, deleted)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

/* handleAdminDeleteUser is DELETE /api/admin/users/{id}.
 *
 * Refuses to delete the caller's own account, the same lockout
 * handleSetHostCapability applies to self-revoke and for the identical
 * reason: it is the one action with no way back from inside the app, since
 * the account that would undo it is the one just removed.
 *
 * Refuses an account that still hosts webinars with a specific, actionable
 * error rather than a raw constraint violation — see store.ErrHasWebinars.
 * Deleting those first is the admin's own explicit action (handleAdminDeleteWebinar,
 * above), not something this endpoint does on their behalf.
 */
func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	if targetID == admin.ID {
		httpx.Error(w, http.StatusUnprocessableEntity, "cannot_self_delete",
			"You can't delete your own account.")
		return
	}

	err := s.store.DeleteUser(r.Context(), targetID)
	switch {
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	case errors.Is(err, store.ErrHasWebinars):
		httpx.Error(w, http.StatusConflict, "has_webinars",
			"This account still hosts webinars. Delete those first, then delete the account.")
		return
	case err != nil:
		s.fail(w, r, "admin delete user", err)
		return
	}

	s.log.Info("account deleted by admin", "admin", admin.ID, "target", targetID)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}
