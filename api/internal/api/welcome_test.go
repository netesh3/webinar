package api_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/notify"
	"github.com/netkumar/webcast/api/types"
)

/* fakeMail is a configured transport that records what it was asked to send, optionally
 * failing every send. Configured() is true so the outbox really attempts delivery rather
 * than marking the row skipped. */
type fakeMail struct {
	mu   sync.Mutex
	sent []notify.Message
	fail error
}

func (f *fakeMail) Configured() bool { return true }

func (f *fakeMail) Send(_ context.Context, m notify.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	f.sent = append(f.sent, m)
	return nil
}

func (f *fakeMail) welcomesTo(email string) []notify.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []notify.Message
	for _, m := range f.sent {
		if m.To == email && strings.HasPrefix(m.Subject, "Welcome to ") {
			out = append(out, m)
		}
	}
	return out
}

func withWelcome(cfg *config.Config) {
	cfg.WelcomeEmail = true
	cfg.AppName = "Webinar Liv"
	cfg.ContactEmail = "webinarliv@gmail.com"
	cfg.ContactPhone = "+91-9852411280"
}

func (h *harness) welcomeRows(email string) (total, pending int) {
	h.t.Helper()
	err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*), count(*) FILTER (WHERE delivery = 'pending')
		  FROM notifications WHERE kind = 'welcome' AND email = $1`, email).Scan(&total, &pending)
	if err != nil {
		h.t.Fatal(err)
	}
	return total, pending
}

func TestSignupSendsExactlyOneWelcomeEmail(t *testing.T) {
	h := newHarness(t, withWelcome)
	mail := &fakeMail{}
	h.server.UseMail(mail)

	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Priya <b>Sharma</b>", Email: "Priya.New@Test.dev", Password: "any-password",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup: status %d body %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()

	got := mail.welcomesTo("priya.new@test.dev")
	if len(got) != 1 {
		t.Fatalf("welcome emails = %d, want 1", len(got))
	}
	m := got[0]
	if m.Subject != "Welcome to Webinar Liv, Priya" {
		t.Errorf("subject = %q", m.Subject)
	}
	if m.HTML == "" || !strings.Contains(m.Body, "webinarliv@gmail.com") ||
		!strings.Contains(m.Body, "+91-9852411280") ||
		!strings.Contains(m.Body, "http://localhost:3000/host") {
		t.Errorf("welcome body incomplete:\n%s", m.Body)
	}
	if strings.Contains(m.HTML, "<b>Sharma</b>") {
		t.Error("the name reached the HTML unescaped")
	}

	// Signing in again, or signing up again with the same address, sends nothing more.
	res, raw = h.do(http.MethodPost, "/api/auth/logout", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("logout: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{
		Email: "priya.new@test.dev", Password: "any-password",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login: status %d body %s", res.StatusCode, raw)
	}
	res, _ = h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Priya", Email: "priya.new@test.dev", Password: "another",
	})
	if res.StatusCode == http.StatusCreated {
		t.Fatal("a second signup with the same address was accepted")
	}
	h.server.WaitBackground()
	if n := len(mail.welcomesTo("priya.new@test.dev")); n != 1 {
		t.Errorf("after a second login: welcome emails = %d, want still 1", n)
	}
	if total, _ := h.welcomeRows("priya.new@test.dev"); total != 1 {
		t.Errorf("welcome rows = %d, want 1", total)
	}
}

func TestGoogleSignupWelcomesOnceAndNotOnReturn(t *testing.T) {
	h := newHarness(t, withSupabaseAuth, withWelcome)
	mail := &fakeMail{}
	h.server.UseMail(mail)

	token := signTestSupabaseToken(t, "google-welcome@test.dev", "")
	for i := 0; i < 3; i++ {
		res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{AccessToken: token})
		want := http.StatusOK
		if i == 0 {
			want = http.StatusCreated
		}
		if res.StatusCode != want {
			t.Fatalf("google sign-in %d: status %d body %s", i, res.StatusCode, raw)
		}
		h.server.WaitBackground()
	}

	got := mail.welcomesTo("google-welcome@test.dev")
	if len(got) != 1 {
		t.Fatalf("welcome emails = %d, want exactly 1 across three Google sign-ins", len(got))
	}
	// Google gave no name: the greeting falls back rather than saying "Hi ,".
	if got[0].Subject != "Welcome to Webinar Liv" || !strings.HasPrefix(got[0].Body, "Hi there,") {
		t.Errorf("nameless welcome: subject %q, body starts %q", got[0].Subject, got[0].Body[:20])
	}
}

// An existing password account that later signs in with Google is not "new".
func TestGoogleLinkToExistingAccountDoesNotWelcome(t *testing.T) {
	h := newHarness(t, withSupabaseAuth, withWelcome)
	mail := &fakeMail{}
	h.server.UseMail(mail)

	// The seeded demo accounts predate the welcome email, like every real account did.
	token := signTestSupabaseToken(t, "neeraj@acme.dev", "Neeraj")
	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{AccessToken: token})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("google link: status %d body %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()
	if n := len(mail.welcomesTo("neeraj@acme.dev")); n != 0 {
		t.Errorf("an existing account was welcomed %d time(s)", n)
	}
}

func TestWelcomeMailFailureDoesNotFailSignup(t *testing.T) {
	h := newHarness(t, withWelcome)
	mail := &fakeMail{fail: errors.New("smtp: 451 try again later")}
	h.server.UseMail(mail)

	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Asha", Email: "asha-fail@test.dev", Password: "pw",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup with a failing mailer: status %d body %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()

	// Still owed, for the sweep to retry — not lost, and not failed for good on one error.
	if total, pending := h.welcomeRows("asha-fail@test.dev"); total != 1 || pending != 1 {
		t.Errorf("welcome rows total=%d pending=%d, want 1 pending", total, pending)
	}
	res, _ = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Errorf("the new session does not work after a mail failure: %d", res.StatusCode)
	}
}

func TestWelcomeEmailCanBeSwitchedOff(t *testing.T) {
	h := newHarness(t) // WelcomeEmail is false in the harness's base config
	mail := &fakeMail{}
	h.server.UseMail(mail)

	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Off", Email: "off@test.dev", Password: "pw",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup: status %d body %s", res.StatusCode, raw)
	}
	h.server.WaitBackground()
	if total, _ := h.welcomeRows("off@test.dev"); total != 0 || len(mail.welcomesTo("off@test.dev")) != 0 {
		t.Error("welcome queued with WELCOME_EMAIL off")
	}
}
