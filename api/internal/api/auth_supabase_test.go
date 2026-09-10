package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

const testSupabaseURL = "https://example.supabase.co"
const testSupabaseJWT = "test-supabase-jwt-secret-for-api-exchange"

func signTestSupabaseToken(t *testing.T, email, name string) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":   "22222222-2222-2222-2222-222222222222",
		"email": email,
		"role":  "authenticated",
		"iss":   testSupabaseURL + "/auth/v1",
		"aud":   "authenticated",
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
		"user_metadata": map[string]any{
			"full_name": name,
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(testSupabaseJWT))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func withSupabaseAuth(cfg *config.Config) {
	cfg.SupabaseURL = testSupabaseURL
	cfg.SupabaseAnonKey = "public-anon-key-for-tests"
	cfg.SupabaseJWTSecret = testSupabaseJWT
}

func TestSupabaseAuthCreatesAndSignsIn(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)

	token := signTestSupabaseToken(t, "google-new@test.dev", "Google New")
	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: token,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d body %s", res.StatusCode, raw)
	}
	var created types.Account
	h.decode(raw, &created)
	if created.Email != "google-new@test.dev" || created.Name != "Google New" {
		t.Fatalf("account %+v", created)
	}
	if created.CanHost {
		t.Fatal("oauth signup must not grant hosting")
	}

	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me after create: status %d body %s", res.StatusCode, raw)
	}

	// Second exchange on the same account is a sign-in (200).
	res, raw = h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseToken(t, "google-new@test.dev", "Google New"),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("sign-in: status %d body %s", res.StatusCode, raw)
	}
}

func TestSupabaseAuthLinksExistingPasswordAccount(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)
	acct := h.signup("Ada", "ada-google@test.dev", false)

	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseToken(t, "ada-google@test.dev", "Ada Google"),
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("link: status %d body %s", res.StatusCode, raw)
	}
	var linked types.Account
	h.decode(raw, &linked)
	if linked.ID != acct.ID {
		t.Fatalf("expected same user id %s got %s", acct.ID, linked.ID)
	}
}

func TestSupabaseAuthSignupClosed(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) {
		withSupabaseAuth(cfg)
		cfg.SignupOpen = false
	})
	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseToken(t, "closed@test.dev", "Closed"),
	})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d body %s, want 403", res.StatusCode, raw)
	}
}

func TestSupabaseAuthRejectsBadToken(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)
	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: "not-a-jwt",
	})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d body %s, want 401", res.StatusCode, raw)
	}
}

func TestSupabaseAuthUnavailableWhenUnconfigured(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseToken(t, "x@test.dev", "X"),
	})
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d body %s, want 503", res.StatusCode, raw)
	}
}

func TestConfigExposesGoogleAuth(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)
	res, raw := h.do(http.MethodGet, "/api/config", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("config: %d %s", res.StatusCode, raw)
	}
	var cfg types.AppConfig
	h.decode(raw, &cfg)
	if !cfg.GoogleAuth || cfg.SupabaseURL != testSupabaseURL || cfg.SupabaseAnonKey == "" {
		t.Fatalf("config google auth: %+v", cfg)
	}
	if strings.Contains(string(raw), testSupabaseJWT) {
		t.Fatal("jwt secret leaked in /api/config")
	}
}
