package api

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const verifyEmailMessage = "Verify your email to continue."

/* queueEmailVerification sends the one-time link through the same outbox as every other mail.
 *
 * Nothing here fails the signup. The row is written before the response; the send happens
 * after, and the sweep retries whatever is still owed. A second call retires the previous
 * unused token, which is what resend does.
 */
func (s *Server) queueEmailVerification(ctx context.Context, user store.User) {
	if user.EmailVerified() {
		return
	}
	email := strings.ToLower(strings.TrimSpace(user.Email))
	if email == "" || strings.HasSuffix(email, ".invalid") {
		return
	}

	raw, err := s.store.IssueEmailVerification(ctx, user.ID)
	if err != nil {
		s.log.Error("verify email: could not issue token", "user", user.ID, "err", err)
		return
	}

	link := strings.TrimRight(s.cfg.WebBaseURL, "/") + "/verify-email?token=" + url.QueryEscape(raw)
	subject, body := notify.VerifyEmail(s.cfg.AppName, user.Name, link)

	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
		Email:   email,
		Kind:    types.NotifyEmailVerify,
		Subject: subject,
		Body:    body,
	}); err != nil {
		s.log.Error("verify email: could not queue", "user", user.ID, "err", err)
		return
	}
	s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
}

/* deliverCompletedRegistrations sends the join link for registrations the
 * verification link just finished.
 *
 * A failure to mail does not undo the verification. The registration is
 * already approved (or waiting on the host), which is the same rule as a
 * registration that did not need this step. Manual-approval webinars still
 * wait for the host; the join link goes out when they approve, not here.
 */
func (s *Server) deliverCompletedRegistrations(ctx context.Context, done []store.CompletedRegistration) {
	for _, item := range done {
		wb, err := s.store.WebinarBySlug(ctx, item.Registration.WebinarID)
		if err != nil {
			s.log.Error("verify email: load webinar", "webinar", item.Registration.WebinarID, "err", err)
			continue
		}
		if item.Registration.State == types.RegPending {
			s.alertHostOfPending(ctx, wb, item.Registration)
		} else if strings.TrimSpace(item.Registration.Email) != "" {
			s.notifyNewRegistration(ctx, wb, item.Registration, true)
		}
		s.engage.OnRegistered(ctx, wb, item.Registration, item.WhatsAppOptIn)
	}
}

func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req types.VerifyEmailRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	_, done, err := s.store.RedeemEmailVerification(r.Context(), req.Token)
	switch {
	case err == nil:
		// The address is confirmed. Webinar registrations that were waiting on
		// this link become real now, and the join link goes out in that mail.
		// Nothing here signs the person in.
		s.deliverCompletedRegistrations(r.Context(), done)
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "verified"})
	case errors.Is(err, store.ErrVerifyExpired):
		httpx.Error(w, http.StatusBadRequest, "expired_token",
			"That verification link has expired. Ask for a new one.")
	default:
		if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrVerifyUsed) {
			s.fail(w, r, "verify email", err)
			return
		}
		httpx.Error(w, http.StatusBadRequest, "invalid_token",
			"That verification link is not valid.")
	}
}

func (s *Server) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	var req types.ResendVerificationRequest
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

	if s.emailResend != nil {
		if ok, retry := s.emailResend.Allow("email:" + email); !ok {
			retryAfter(w, retry)
			httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
				"Wait a little, then ask for another link.")
			return
		}
		if ok, retry := s.emailResend.Allow("ip:" + httpx.ClientIP(r)); !ok {
			retryAfter(w, retry)
			httpx.Error(w, http.StatusTooManyRequests, "rate_limited",
				"Wait a little, then ask for another link.")
			return
		}
	}

	// The same answer whether or not the address is waiting. A different one would
	// tell a stranger which accounts exist and which of them are unverified.
	const sent = "If that address is waiting to be verified, we sent another link."

	user, err := s.store.UserByEmail(r.Context(), email)
	if errors.Is(err, store.ErrNotFound) || (err == nil && user.EmailVerified()) {
		httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: sent})
		return
	}
	if err != nil {
		s.fail(w, r, "resend verification", err)
		return
	}
	s.queueEmailVerification(r.Context(), user)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: sent})
}

func retryAfter(w http.ResponseWriter, d time.Duration) {
	secs := int(d.Seconds()) + 1
	if secs < 1 {
		secs = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(secs))
}
