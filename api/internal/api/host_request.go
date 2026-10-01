package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleHostRequest is POST /api/me/host-request.
 *
 * A signed-in account that cannot host asks to. The phone is collected only
 * when the account does not already have one, then one email goes to the
 * review inbox. The row is what stops a second click from sending another.
 * CanHost is not touched.
 */
func (s *Server) handleHostRequest(w http.ResponseWriter, r *http.Request) {
	var req types.HostRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	user := userFromContext(r.Context())
	if user.CanHost {
		httpx.Error(w, http.StatusForbidden, "already_host",
			"Hosting is already enabled for this account.")
		return
	}
	if user.HostRequestedAt != nil {
		httpx.Error(w, http.StatusConflict, "host_request_exists",
			"Your hosting request is already in.")
		return
	}
	if strings.TrimSpace(user.Phone) == "" {
		if strings.TrimSpace(req.Phone) == "" {
			httpx.Fields(w, map[string]string{"phone": "Required."})
			return
		}
		if msg := phoneFieldError(req.Phone); msg != "" {
			httpx.Fields(w, map[string]string{"phone": msg})
			return
		}
	}

	updated, err := s.store.RecordHostRequest(r.Context(), user.ID, req.Phone)
	switch {
	case errors.Is(err, store.ErrAlreadyHost):
		httpx.Error(w, http.StatusForbidden, "already_host",
			"Hosting is already enabled for this account.")
		return
	case errors.Is(err, store.ErrHostRequested):
		httpx.Error(w, http.StatusConflict, "host_request_exists",
			"Your hosting request is already in.")
		return
	case errors.Is(err, store.ErrPhoneRequired):
		httpx.Fields(w, map[string]string{"phone": "Required."})
		return
	case err != nil:
		s.fail(w, r, "host request", err)
		return
	}

	subject, body := notify.HostRequestEmail(notify.HostRequestNotice{
		Name:   updated.Name,
		Email:  updated.Email,
		Phone:  updated.Phone,
		UserID: updated.ID,
	})
	if err := s.mail.Send(r.Context(), notify.Message{
		To:      notify.HostRequestRecipient,
		Subject: subject,
		Body:    body,
		ReplyTo: updated.Email,
	}); err != nil {
		if clearErr := s.store.ClearHostRequest(r.Context(), updated.ID); clearErr != nil {
			s.log.Error("host request: could not clear after send failure",
				"user", updated.ID, "err", clearErr)
		}
		s.fail(w, r, "host request email", err)
		return
	}

	httpx.JSON(w, http.StatusOK, updated.Public())
}
