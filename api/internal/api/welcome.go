package api

import (
	"context"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The welcome email, queued once per new account.
 *
 * Called from the two doors a person creates an account through: the signup form and a
 * first Google sign-in. Not from the others, on purpose:
 *
 *   AUTH_BYPASS   provisions guest-…@bypass.invalid accounts for a demo; nobody to thank.
 *   ADMIN_EMAILS  EnsureAdminAccount bootstraps the operator's own account.
 *   SEED_DEV      demo hosts in a development database.
 *
 * Queued through the outbox like every other email, so it inherits the same guarantees:
 * recorded as 'skipped' when no SMTP is configured (dev and tests send nothing), retried
 * with backoff on a failed send, and one per address by a unique index (migration 0058) —
 * a double-submitted form or a signup racing a Google sign-in cannot send two.
 *
 * Nothing here can fail the signup. The row is one INSERT; the send happens after the
 * response, on a goroutine with its own deadline. An error at either step is logged and
 * the next sweep picks up whatever is still owed.
 */
func (s *Server) queueWelcome(ctx context.Context, user store.User) {
	if !s.cfg.WelcomeEmail {
		return
	}
	email := strings.ToLower(strings.TrimSpace(user.Email))
	if email == "" || strings.HasSuffix(email, ".invalid") {
		return
	}

	subject, text, html := notify.WelcomeEmail(notify.Welcome{
		Product:      s.cfg.AppName,
		Name:         user.Name,
		Email:        email,
		DashboardURL: strings.TrimRight(s.cfg.WebBaseURL, "/") + dashboardPath(user),
		ContactEmail: s.cfg.ContactEmail,
		ContactPhone: s.cfg.ContactPhone,
	})

	// Detached from the request: the client may hang up the moment it has its cookie,
	// and that must not cancel the INSERT half-way.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.store.Notify(ctx, s.store.DB(), store.Notification{
		Email:   email,
		Kind:    types.NotifyWelcome,
		Subject: subject,
		Body:    text,
		HTML:    html,
	}); err != nil {
		s.log.Error("welcome email: could not queue", "user", user.ID, "err", err)
		return
	}
}

/* flushMailSoon sends whatever the outbox already has, after the response.
 *
 * One call per request, after every row for that request is inserted. Two
 * flushes started a moment apart lose: the second finds the lease held and
 * the first has already read the queue, so a welcome row written between
 * them waits for the sweep.
 */
func (s *Server) flushMailSoon() {
	s.inBackground(func(ctx context.Context) { s.flushOutbox(ctx) })
}

// dashboardPath is where the email's button lands: the same place the signup form sends
// a new account (web/components/auth-form.tsx).
func dashboardPath(user store.User) string {
	if user.CanHost {
		return "/host"
	}
	return "/my-webinars"
}

// welcomeFlushBudget bounds one after-signup flush, including a slow SMTP server.
const welcomeFlushBudget = 90 * time.Second

/* inBackground runs work after the response, tracked so that a test (or a shutdown) can
 * wait for it rather than sleep. */
func (s *Server) inBackground(fn func(ctx context.Context)) {
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		ctx, cancel := context.WithTimeout(context.Background(), welcomeFlushBudget)
		defer cancel()
		fn(ctx)
	}()
}

// WaitBackground blocks until work started by inBackground has finished.
func (s *Server) WaitBackground() { s.background.Wait() }

// UseMail replaces the email transport. For tests, and for a caller that brings its own.
func (s *Server) UseMail(t notify.Transport) {
	if t == nil {
		t = notify.Discard{Log: s.log}
	}
	s.mail = t
}
