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
