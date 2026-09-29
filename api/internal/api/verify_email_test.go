package api_test

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

var verifyTokenPattern = regexp.MustCompile(`token=([0-9a-f]+)`)

func (h *harness) latestVerifyToken(email string) string {
	h.t.Helper()
	var body string
	err := h.store.Pool().QueryRow(context.Background(), `
		SELECT body FROM notifications
		 WHERE kind = 'email_verify' AND email = $1
		 ORDER BY created_at DESC
		 LIMIT 1`, strings.ToLower(email)).Scan(&body)
	if err != nil {
		h.t.Fatalf("verification mail for %s: %v", email, err)
	}
	m := verifyTokenPattern.FindStringSubmatch(body)
	if m == nil {
		h.t.Fatalf("verification mail has no token:\n%s", body)
	}
	return m[1]
}

func (h *harness) verifyHash(email string) string {
	h.t.Helper()
	var hash string
	err := h.store.Pool().QueryRow(context.Background(), `
		SELECT token_hash
		  FROM email_verification_tokens t
		  JOIN users u ON u.id = t.user_id
		 WHERE lower(u.email) = lower($1) AND t.used_at IS NULL
		 ORDER BY t.created_at DESC
		 LIMIT 1`, email).Scan(&hash)
	if err != nil {
		h.t.Fatalf("verification hash for %s: %v", email, err)
	}
	return hash
}

func TestUnverifiedAccountCannotSignIn(t *testing.T) {
	h := newHarness(t)

	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Una Verified", Email: "unverified@test.dev", Password: "webcast-dev",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup: status %d body %s", res.StatusCode, raw)
	}
	var pending types.SignupResponse
	h.decode(raw, &pending)
	if pending.Status != "verify_email" || pending.Email != "unverified@test.dev" ||
		pending.Message != "Verify your email to continue." {
		t.Fatalf("signup response = %+v", pending)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("signup set a session cookie")
	}

	token := h.latestVerifyToken("unverified@test.dev")
	hash := h.verifyHash("unverified@test.dev")
	if hash == token {
		t.Fatal("the raw token was stored")
	}
	if hash != store.EmailVerifyHash(token) {
		t.Fatalf("stored hash = %s, want sha256 of the token", hash)
	}

	res, raw = h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{
		Email: "unverified@test.dev", Password: "webcast-dev",
	})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("login before verify: status %d body %s, want 403", res.StatusCode, raw)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if apiErr.Error != "email_unverified" || apiErr.Message != "Verify your email to continue." {
		t.Fatalf("login error = %+v", apiErr)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("refused login still set a session cookie")
	}

	res, raw = h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{
		Email: "unverified@test.dev", Password: "wrong-password",
	})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password: status %d body %s, want 401", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me before verify: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: "not-a-real-token"})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad token: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &apiErr)
	if apiErr.Error != "invalid_token" {
		t.Fatalf("bad token code = %s", apiErr.Error)
	}

	if _, err := h.store.Pool().Exec(context.Background(), `
		UPDATE email_verification_tokens
		   SET expires_at = now() - interval '1 minute'
		 WHERE token_hash = $1`, hash); err != nil {
		t.Fatal(err)
	}
	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: token})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expired token: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &apiErr)
	if apiErr.Error != "expired_token" {
		t.Fatalf("expired token code = %s", apiErr.Error)
	}

	res, raw = h.do(http.MethodPost, "/api/auth/email/resend", types.ResendVerificationRequest{
		Email: "unverified@test.dev",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("resend: status %d body %s", res.StatusCode, raw)
	}
	resent := h.latestVerifyToken("unverified@test.dev")
	if resent == token {
		t.Fatal("resend reused the expired token")
	}
	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: token})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("old token after resend: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: resent})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("verify: status %d body %s", res.StatusCode, raw)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("verifying the link signed them in; sign-in is a separate step")
	}
	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: resent})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("second use: status %d body %s, want 400", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{
		Email: "unverified@test.dev", Password: "webcast-dev",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login after verify: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if !acct.EmailVerified {
		t.Fatal("verified account still reports emailVerified false")
	}
	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me after verify: status %d body %s", res.StatusCode, raw)
	}
}

func TestVerificationResendIsRateLimited(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodPost, "/api/auth/signup", types.SignupRequest{
		Name: "Rate Limited", Email: "resend-limit@test.dev", Password: "webcast-dev",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("signup: status %d body %s", res.StatusCode, raw)
	}

	for i := 0; i < 3; i++ {
		res, raw = h.do(http.MethodPost, "/api/auth/email/resend", types.ResendVerificationRequest{
			Email: "resend-limit@test.dev",
		})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("resend %d: status %d body %s", i+1, res.StatusCode, raw)
		}
	}
	res, raw = h.do(http.MethodPost, "/api/auth/email/resend", types.ResendVerificationRequest{
		Email: "resend-limit@test.dev",
	})
	if res.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("fourth resend: status %d body %s, want 429", res.StatusCode, raw)
	}

	token := h.latestVerifyToken("resend-limit@test.dev")
	res, raw = h.do(http.MethodPost, "/api/auth/email/verify", types.VerifyEmailRequest{Token: token})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("token from the last allowed resend: status %d body %s", res.StatusCode, raw)
	}
}

func TestGoogleSignupIsVerifiedImmediately(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)

	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseToken(t, "google-verified@test.dev", "Google Verified"),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("google signup: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if !acct.EmailVerified {
		t.Fatal("google signup was left unverified")
	}
	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me: status %d body %s", res.StatusCode, raw)
	}

	var n int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM notifications
		 WHERE kind = 'email_verify' AND email = $1`, "google-verified@test.dev").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("verification mails = %d, want 0 for a Google address", n)
	}
}

func TestGoogleUnverifiedEmailIsRefused(t *testing.T) {
	h := newHarness(t, withSupabaseAuth)
	res, raw := h.do(http.MethodPost, "/api/auth/supabase", types.SupabaseAuthRequest{
		AccessToken: signTestSupabaseTokenUnverified(t, "google-unverified@test.dev"),
	})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d body %s, want 403", res.StatusCode, raw)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("an unverified Google token was signed in")
	}
	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me: status %d body %s", res.StatusCode, raw)
	}
}

func signTestSupabaseTokenUnverified(t *testing.T, email string) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":   "33333333-3333-3333-3333-333333333333",
		"email": email,
		"role":  "authenticated",
		"iss":   testSupabaseURL + "/auth/v1",
		"aud":   "authenticated",
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
		"user_metadata": map[string]any{
			"full_name":      "Unverified Google",
			"email_verified": false,
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	s, err := tok.SignedString([]byte(testSupabaseJWT))
	if err != nil {
		t.Fatal(err)
	}
	return s
}
