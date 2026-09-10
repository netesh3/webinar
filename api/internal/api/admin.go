package api

import (
	"errors"
	"net/http"

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
