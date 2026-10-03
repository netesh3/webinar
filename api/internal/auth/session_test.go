package auth

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSetCookieSameSiteNoneWhenSecure(t *testing.T) {
	s := NewSessions("test-session-secret-at-least-32-bytes!!", time.Hour, true)
	rec := httptest.NewRecorder()
	s.SetCookie(rec, "tok", time.Now().Add(time.Hour))

	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatal("missing Set-Cookie")
	}
	if !strings.Contains(setCookie, "SameSite=None") {
		t.Fatalf("secure cookie must be SameSite=None for cross-origin; got %q", setCookie)
	}
	if !strings.Contains(setCookie, "Secure") {
		t.Fatalf("expected Secure flag; got %q", setCookie)
	}
}

func TestSetCookieSameSiteLaxWhenInsecure(t *testing.T) {
	s := NewSessions("test-session-secret-at-least-32-bytes!!", time.Hour, false)
	rec := httptest.NewRecorder()
	s.SetCookie(rec, "tok", time.Now().Add(time.Hour))

	setCookie := rec.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "SameSite=Lax") {
		t.Fatalf("insecure local cookie should be SameSite=Lax; got %q", setCookie)
	}
	if strings.Contains(setCookie, "SameSite=None") {
		t.Fatalf("SameSite=None requires Secure; got %q", setCookie)
	}
}

func TestClearCookieMatchesSameSite(t *testing.T) {
	s := NewSessions("test-session-secret-at-least-32-bytes!!", time.Hour, true)
	rec := httptest.NewRecorder()
	s.ClearCookie(rec)
	setCookie := rec.Header().Get("Set-Cookie")
	if !strings.Contains(setCookie, "SameSite=None") {
		t.Fatalf("clear cookie must match Secure SameSite=None; got %q", setCookie)
	}
}

func TestVerifyReturnsWhoAndWhen(t *testing.T) {
	s := NewSessions("test-session-secret-at-least-32-bytes!!", time.Hour, false)
	before := time.Now().Truncate(time.Second)
	token, _, err := s.Issue("user-1")
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now()

	got, err := s.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.UserID != "user-1" {
		t.Errorf("user = %q, want user-1", got.UserID)
	}
	// Whole seconds: the issue time is the start of the second it was signed in.
	if got.IssuedAt.Before(before) || got.IssuedAt.After(after) {
		t.Errorf("issued at %v, want between %v and %v", got.IssuedAt, before, after)
	}
	if got.IssuedAt.Nanosecond() != 0 {
		t.Errorf("issued at %v carries sub-second precision a JWT cannot", got.IssuedAt)
	}

	if _, err := s.Verify(token + "x"); err == nil {
		t.Error("a tampered token verified")
	}
}
