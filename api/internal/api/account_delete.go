package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleDeleteAccount is DELETE /api/auth/account: the signed-in account erases itself.
 *
 * Re-confirmed, since a stolen session should not be enough: the password, or for a
 * Google-only account (no password) the email typed back. Refused while one of the
 * account's webinars is live, and for an admin, whom PromoteAdmins would re-create
 * from ADMIN_EMAILS at the next boot.
 *
 * Every webinar the account hosts goes the way a host's own delete takes it
 * (deleteWebinarBySlug: room, rows, files), then the account row, which cascades the
 * rest, then the avatar and the WhatsApp media files. Billing orders are kept,
 * unlinked (migration 0104). */
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	var body types.DeleteAccountRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if user.PasswordHash != "" {
		if auth.VerifyPassword(body.Password, user.PasswordHash) != nil {
			httpx.Error(w, http.StatusUnauthorized, "wrong_password", "That password isn't right.")
			return
		}
	} else {
		typed := strings.ToLower(strings.TrimSpace(body.Email))
		want := strings.ToLower(strings.TrimSpace(user.Email))
		if typed == "" || subtle.ConstantTimeCompare([]byte(typed), []byte(want)) != 1 {
			httpx.Error(w, http.StatusUnprocessableEntity, "email_mismatch",
				"Type your account's email address to confirm.")
			return
		}
	}
	if user.IsAdmin {
		httpx.Error(w, http.StatusConflict, "admin_account",
			"Admin accounts are set by ADMIN_EMAILS. Remove this address from it first, then delete the account.")
		return
	}

	slugs, live, err := s.store.WebinarSlugsHostedBy(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "delete account: webinars", err)
		return
	}
	if live {
		httpx.Error(w, http.StatusConflict, "webinar_live",
			"One of your webinars is live. End it, then delete your account.")
		return
	}
	for _, slug := range slugs {
		cancellations := s.panelistCancellations(r.Context(), slug)
		deleted, err := s.deleteWebinarBySlug(r.Context(), slug)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			s.fail(w, r, "delete account: webinar", err)
			return
		}
		s.sendPanelistCancellations(r.Context(), cancellations)
		s.logWebinarDeleted(slug, deleted)
	}

	avatarKey, err := s.store.DeleteUser(r.Context(), user.ID)
	switch {
	case errors.Is(err, store.ErrHasWebinars):
		// A webinar created between the list and the delete. Nothing is half-gone:
		// the account row is still there and another try finishes the job.
		httpx.Error(w, http.StatusConflict, "has_webinars", "A webinar was just created. Try again.")
		return
	case errors.Is(err, store.ErrNotFound):
		// Already deleted, by a second click or an admin. The outcome asked for.
	case err != nil:
		s.fail(w, r, "delete account", err)
		return
	}
	s.removeAccountFiles(r.Context(), user.ID, avatarKey)
	s.sessions.ClearCookie(w)
	s.log.Info("account deleted by its owner", "user", user.ID, "webinars", len(slugs))
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "deleted"})
}

/* removeAccountFiles deletes what a deleted account left in the media store that
 * no row points at any more: the avatar, and the WhatsApp attachments the CRM
 * keeps under wa/<host>/ (see engage/wa_media.go). Logged, never fatal: the rows
 * are gone, so the account is. */
func (s *Server) removeAccountFiles(ctx context.Context, userID, avatarKey string) {
	if s.recordings == nil {
		return
	}
	if avatarKey != "" {
		if err := s.recordings.Delete(ctx, avatarKey); err != nil {
			s.log.Warn("delete account: avatar left behind", "user", userID, "key", avatarKey, "error", err)
		}
	}
	if err := s.recordings.DeletePrefix(ctx, "wa/"+userID+"/"); err != nil {
		s.log.Warn("delete account: whatsapp media left behind", "user", userID, "error", err)
	}
}
