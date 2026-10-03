package api

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Password reset: a link to the account's own address that lets its holder choose a new
 * password.
 *
 * Built the way email verification is (verify_email.go), because it is the same problem —
 * somebody who cannot sign in proves they read an inbox. The token is single-use, only its
 * hash is stored, and the mail goes through the outbox like every other. What differs is
 * what the link is worth: it sets the password and signs the holder in, so it lasts an hour
 * rather than a day, and using it signs out every session issued before.
 */

// The same answer whether or not an account uses the address. A different one would tell
// a stranger which addresses have accounts here.
const resetSentMessage = "If an account uses that address, we sent a link to reset its password."

/* queuePasswordReset mints a reset link for this account and puts the mail in the outbox.
 *
 * Silent on failure, like queueEmailVerification: the caller answers the same way whatever
 * happens here, so an error is a log line rather than a response.
 */
func (s *Server) queuePasswordReset(ctx context.Context, user store.User) {
	email := strings.ToLower(strings.TrimSpace(user.Email))
	// .invalid is the AUTH_BYPASS fixture's address. Nobody reads it.
	if email == "" || strings.HasSuffix(email, ".invalid") {
		return
	}

	raw, err := s.store.IssuePasswordReset(ctx, user.ID)
	if err != nil {
		s.log.Error("password reset: could not issue token", "user", user.ID, "err", err)
		return
	}

	link := strings.TrimRight(s.cfg.WebBaseURL, "/") + "/reset-password?token=" + url.QueryEscape(raw)
	subject, body := notify.PasswordReset(s.cfg.AppName, user.Name, link)

	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
		Email:   email,
		Kind:    types.NotifyPasswordReset,
		Subject: subject,
		Body:    body,
	}); err != nil {
		s.log.Error("password reset: could not queue", "user", user.ID, "err", err)
		return
	}
	s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
}

func (s *Server) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var req types.ForgotPasswordRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || len(email) > 320 {
		httpx.Error(w, http.StatusUnprocessableEntity, "validation_failed",
			"That doesn't look like an email address.")
		return
	}
	if _, err := mail.ParseAddress(email); err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "validation_failed",
			"That doesn't look like an email address.")
		return
	}

	/* Per address as well as per IP. The address bucket stops somebody filling a stranger's
	 * inbox with reset mail from many IPs; the IP bucket stops one client walking a list of
	 * addresses. */
	if s.passwordReset != nil {
		for _, key := range []string{"email:" + email, "ip:" + httpx.ClientIP(r)} {
			if ok, retry := s.passwordReset.Allow(key); !ok {
				retryAfter(w, retry)
				httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
					"Wait a little, then ask for another link.")
				return
			}
		}
	}

	user, err := s.store.UserByEmail(r.Context(), email)
	switch {
	case errors.Is(err, store.ErrNotFound):
		// Nobody to send it to. The answer is the same either way.
	case err != nil:
		s.fail(w, r, "forgot password", err)
		return
	default:
		s.log.Info("password reset requested", "user", user.ID)
		s.queuePasswordReset(r.Context(), user)
	}
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: resetSentMessage})
}

func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var req types.ResetPasswordRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if msg := passwordFieldError(req.Password); msg != "" {
		httpx.Fields(w, map[string]string{"password": msg})
		return
	}

	// Hashed before the token is looked at, so the slow part never runs inside its lock.
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		s.fail(w, r, "reset password: hash", err)
		return
	}

	userID, done, err := s.store.RedeemPasswordReset(r.Context(), req.Token, hash)
	switch {
	case errors.Is(err, store.ErrResetExpired):
		httpx.Error(w, http.StatusBadRequest, "expired_token",
			"That reset link has expired. Ask for a new one.")
		return
	case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrResetUsed):
		// Used, replaced and never issued read the same: this link does nothing now, and
		// the way forward is the same for all three.
		httpx.Error(w, http.StatusBadRequest, "invalid_token",
			"That reset link isn't valid any more. Ask for a new one.")
		return
	case err != nil:
		s.fail(w, r, "reset password", err)
		return
	}

	user, err := s.store.UserByID(r.Context(), userID)
	if err != nil {
		s.fail(w, r, "reset password: load account", err)
		return
	}

	/* Signed in with a session issued after the change, which makes it the one session the
	 * change does not end. They have just proved the inbox and chosen the password; sending
	 * them to type it again on the sign-in page would be a form for its own sake. */
	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "reset password: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)
	s.store.TouchLogin(r.Context(), user.ID)
	s.log.Info("password reset", "user", user.ID)

	// Registrations that were waiting for this address to be confirmed get their join link.
	s.deliverCompletedRegistrations(r.Context(), done)
	httpx.JSON(w, http.StatusOK, user.Public())
}
