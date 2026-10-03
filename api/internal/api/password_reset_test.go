package api_test

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Password reset: "Forgot password?" on the sign-in card mails a one-time link, and the
 * link sets a new password and signs the holder in. Before this, an email+password account
 * that forgot its password was locked out for good.
 */

const resetSent = "If an account uses that address, we sent a link to reset its password."

var resetTokenPattern = regexp.MustCompile(`/reset-password\?token=([0-9a-f]+)`)

func (h *harness) latestResetToken(email string) string {
	h.t.Helper()
	var body string
	err := h.store.Pool().QueryRow(context.Background(), `
		SELECT body FROM notifications
		 WHERE kind = 'password_reset' AND email = $1
		 ORDER BY created_at DESC
		 LIMIT 1`, strings.ToLower(email)).Scan(&body)
	if err != nil {
		h.t.Fatalf("reset mail for %s: %v", email, err)
	}
	m := resetTokenPattern.FindStringSubmatch(body)
	if m == nil {
		h.t.Fatalf("reset mail has no link:\n%s", body)
	}
	return m[1]
}

func (h *harness) resetMails(email string) int {
	h.t.Helper()
	var n int
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT count(*) FROM notifications
		 WHERE kind = 'password_reset' AND email = $1`, strings.ToLower(email)).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

// browser is another browser on the same server: its own cookies, nothing else apart.
func (h *harness) browser() *harness {
	h.t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		h.t.Fatal(err)
	}
	return &harness{t: h.t, srv: h.srv, store: h.store, client: &http.Client{Jar: jar}}
}

func (h *harness) forgot(email string) (*http.Response, []byte) {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/auth/password/forgot", types.ForgotPasswordRequest{Email: email})
}

func (h *harness) resetPassword(token, password string) (*http.Response, []byte) {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/auth/password/reset", types.ResetPasswordRequest{
		Token: token, Password: password,
	})
}

func (h *harness) loginStatus(email, password string) int {
	h.t.Helper()
	res, _ := h.do(http.MethodPost, "/api/auth/login", types.LoginRequest{Email: email, Password: password})
	return res.StatusCode
}

func (h *harness) wantError(res *http.Response, raw []byte, status int, code string) {
	h.t.Helper()
	if res.StatusCode != status {
		h.t.Fatalf("status %d body %s, want %d %s", res.StatusCode, raw, status, code)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if apiErr.Error != code {
		h.t.Fatalf("error code = %q (%s), want %q", apiErr.Error, apiErr.Message, code)
	}
}

func TestPasswordResetSetsANewPasswordAndSignsIn(t *testing.T) {
	h := newHarness(t)
	h.signup("Rhea Reset", "rhea@test.dev", false)
	h.logout()

	// The address as somebody types it on the forgot form: not the case it was saved in.
	res, raw := h.forgot("  Rhea@Test.dev ")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("forgot: status %d body %s", res.StatusCode, raw)
	}
	var sent types.StatusResponse
	h.decode(raw, &sent)
	if sent.Status != resetSent {
		t.Fatalf("forgot answered %q", sent.Status)
	}
	if strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("asking for a reset link set a session cookie")
	}

	token := h.latestResetToken("rhea@test.dev")
	var stored string
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT t.token_hash FROM password_reset_tokens t
		  JOIN users u ON u.id = t.user_id
		 WHERE u.email = 'rhea@test.dev'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored == token || stored != store.PasswordResetHash(token) {
		t.Fatalf("stored %q for token %q: want its sha256, never the token", stored, token)
	}
	var subject, body string
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT subject, body FROM notifications
		 WHERE kind = 'password_reset' AND email = 'rhea@test.dev'`).Scan(&subject, &body); err != nil {
		t.Fatal(err)
	}
	if subject != "Reset your Webcast Test password" ||
		!strings.Contains(body, "http://localhost:3000/reset-password?token="+token) {
		t.Fatalf("mail = %q\n%s", subject, body)
	}

	// A refused password does not spend the link.
	res, raw = h.resetPassword(token, "")
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("empty password: status %d body %s, want 422", res.StatusCode, raw)
	}
	var refused types.APIError
	h.decode(raw, &refused)
	if refused.Fields["password"] != "Required." {
		t.Fatalf("empty password fields = %v", refused.Fields)
	}

	res, raw = h.resetPassword(token, "a brand new passphrase")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reset: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.Email != "rhea@test.dev" || !acct.EmailVerified {
		t.Fatalf("reset answered %+v", acct)
	}
	if !strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session") {
		t.Fatal("reset did not sign them in")
	}
	if res, raw := h.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("me after reset: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.resetPassword(token, "another one entirely")
	h.wantError(res, raw, http.StatusBadRequest, "invalid_token")

	h.logout()
	if got := h.loginStatus("rhea@test.dev", "webcast-dev"); got != http.StatusUnauthorized {
		t.Fatalf("old password after reset: status %d, want 401", got)
	}
	if got := h.loginStatus("rhea@test.dev", "a brand new passphrase"); got != http.StatusOK {
		t.Fatalf("new password: status %d, want 200", got)
	}
	if got := h.loginStatus("rhea@test.dev", "another one entirely"); got != http.StatusUnauthorized {
		t.Fatalf("the refused second reset changed the password: status %d", got)
	}
}

func TestPasswordResetSignsOutEveryEarlierSession(t *testing.T) {
	h := newHarness(t)
	h.signup("Two Laptops", "laptops@test.dev", false) // signed in here
	other := h.browser()
	other.login("laptops@test.dev")
	for name, b := range map[string]*harness{"first": h, "second": other} {
		if res, raw := b.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusOK {
			t.Fatalf("%s browser before reset: status %d body %s", name, res.StatusCode, raw)
		}
	}

	// Sessions carry their issue time in whole seconds. Step past the second these were
	// signed in, so they are unambiguously older than the reset.
	time.Sleep(1100 * time.Millisecond)

	third := h.browser()
	if res, raw := third.forgot("laptops@test.dev"); res.StatusCode != http.StatusOK {
		t.Fatalf("forgot: status %d body %s", res.StatusCode, raw)
	}
	res, raw := third.resetPassword(h.latestResetToken("laptops@test.dev"), "the new one")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reset: status %d body %s", res.StatusCode, raw)
	}

	if res, raw := third.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("the browser that reset it: status %d body %s, want signed in", res.StatusCode, raw)
	}
	for name, b := range map[string]*harness{"first": h, "second": other} {
		res, raw := b.do(http.MethodGet, "/api/auth/me", nil)
		b.wantError(res, raw, http.StatusUnauthorized, "unauthenticated")
		if !strings.Contains(res.Header.Get("Set-Cookie"), "webcast_session=;") {
			t.Fatalf("%s browser: the refused session's cookie was not cleared", name)
		}
	}

	// Signing in again with the new password works on the browsers that were signed out.
	if got := other.loginStatus("laptops@test.dev", "the new one"); got != http.StatusOK {
		t.Fatalf("sign in again after reset: status %d", got)
	}
	if res, raw := other.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("new session after reset: status %d body %s", res.StatusCode, raw)
	}
}

func TestForgotPasswordAnswersTheSameForEveryAddress(t *testing.T) {
	h := newHarness(t)
	h.signup("Known Person", "known@test.dev", false)
	h.logout()

	knownRes, known := h.forgot("known@test.dev")
	strangerRes, stranger := h.forgot("nobody-here@test.dev")
	if knownRes.StatusCode != http.StatusOK || strangerRes.StatusCode != http.StatusOK {
		t.Fatalf("statuses %d and %d, want 200 for both", knownRes.StatusCode, strangerRes.StatusCode)
	}
	if string(known) != string(stranger) {
		t.Fatalf("the answer tells the two apart:\n%s\n%s", known, stranger)
	}
	if n := h.resetMails("known@test.dev"); n != 1 {
		t.Fatalf("mails to the account = %d, want 1", n)
	}
	if n := h.resetMails("nobody-here@test.dev"); n != 0 {
		t.Fatalf("mails to an address with no account = %d, want 0", n)
	}

	res, raw := h.forgot("not an address")
	h.wantError(res, raw, http.StatusUnprocessableEntity, "validation_failed")
}

func TestForgotPasswordIsRateLimited(t *testing.T) {
	h := newHarness(t)
	h.signup("Many Asks", "asks@test.dev", false)
	h.logout()

	for i := 1; i <= 3; i++ {
		if res, raw := h.forgot("asks@test.dev"); res.StatusCode != http.StatusOK {
			t.Fatalf("ask %d: status %d body %s", i, res.StatusCode, raw)
		}
	}
	res, raw := h.forgot("asks@test.dev")
	h.wantError(res, raw, http.StatusTooManyRequests, "rate_limited")
	if res.Header.Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}
	if n := h.resetMails("asks@test.dev"); n != 3 {
		t.Fatalf("mails = %d, want 3: the refused ask must not send one", n)
	}

	// The link from the last ask that was allowed still works.
	if res, raw := h.resetPassword(h.latestResetToken("asks@test.dev"), "finally"); res.StatusCode != http.StatusOK {
		t.Fatalf("latest link: status %d body %s", res.StatusCode, raw)
	}
}

func TestReplacedAndExpiredResetLinksAreRefused(t *testing.T) {
	h := newHarness(t)
	h.signup("Old Links", "links@test.dev", false)
	h.logout()

	h.forgot("links@test.dev")
	first := h.latestResetToken("links@test.dev")
	h.forgot("links@test.dev")
	second := h.latestResetToken("links@test.dev")
	if first == second {
		t.Fatal("asking again reused the same link")
	}

	// Only the newest mail works.
	res, raw := h.resetPassword(first, "from the old mail")
	h.wantError(res, raw, http.StatusBadRequest, "invalid_token")

	if _, err := h.store.Pool().Exec(context.Background(), `
		UPDATE password_reset_tokens
		   SET expires_at = now() - interval '1 minute'
		 WHERE token_hash = $1`, store.PasswordResetHash(second)); err != nil {
		t.Fatal(err)
	}
	res, raw = h.resetPassword(second, "too late")
	h.wantError(res, raw, http.StatusBadRequest, "expired_token")

	res, raw = h.resetPassword("not-a-real-token", "anything")
	h.wantError(res, raw, http.StatusBadRequest, "invalid_token")

	// None of that changed the password.
	if got := h.loginStatus("links@test.dev", "webcast-dev"); got != http.StatusOK {
		t.Fatalf("original password after refused resets: status %d", got)
	}
}

/* A webinar registrant has an account with no password and an unconfirmed address until
 * they open the verification link. Reset is how they choose a password — and because the
 * reset link went to the same inbox, using it confirms the address the same way, so the
 * registration that was waiting on it goes through and the join link is mailed.
 */
func TestPasswordResetConfirmsTheAddressAndFinishesWaitingRegistrations(t *testing.T) {
	h := newHarness(t)
	h.holdVerification = true
	h.goLive("simulive-playbook")

	const email = "registrant-reset@test.dev"
	res, raw := h.do(http.MethodPost, "/api/webinars/simulive-playbook/register", types.RegisterRequest{
		FirstName: "Ira", LastName: "Mehta", Email: email, Consent: true,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	var held types.Registration
	h.decode(raw, &held)
	if held.State != types.RegUnverified {
		t.Fatalf("registration state = %s, want it waiting on the address", held.State)
	}

	if res, raw := h.forgot(email); res.StatusCode != http.StatusOK {
		t.Fatalf("forgot: status %d body %s", res.StatusCode, raw)
	}
	res, raw = h.resetPassword(h.latestResetToken(email), "my first password")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("reset: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if !acct.EmailVerified {
		t.Fatal("reset left the address unconfirmed")
	}

	var state, joinKey string
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT r.state, r.join_key FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		 WHERE w.slug = 'simulive-playbook' AND lower(r.email) = $1`, email).Scan(&state, &joinKey); err != nil {
		t.Fatal(err)
	}
	if state != string(types.RegApproved) {
		t.Fatalf("registration state after reset = %s, want approved", state)
	}
	var confirmation string
	if err := h.store.Pool().QueryRow(context.Background(), `
		SELECT body FROM notifications
		 WHERE kind = 'registration_confirmed' AND email = $1
		 ORDER BY created_at DESC LIMIT 1`, email).Scan(&confirmation); err != nil {
		t.Fatalf("confirmation mail after reset: %v", err)
	}
	if !strings.Contains(confirmation, joinKey) {
		t.Fatal("the confirmation mail did not carry the join link")
	}

	h.logout()
	if got := h.loginStatus(email, "my first password"); got != http.StatusOK {
		t.Fatalf("sign in with the chosen password: status %d", got)
	}
}
