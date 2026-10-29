package api_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/types"
)

/* The apps' Google sign-in hand-off (auth_app.go, 29 Oct 2026): the system browser gets a
 * one-time code instead of a session, and only the app holding the verifier can redeem it. */

// fakeGoogleFor stands in for Google's token and certs endpoints, signing every ID token for
// email with whatever nonce the last start asked for.
type fakeGoogleFor struct {
	mu    sync.Mutex
	nonce string
}

func newFakeGoogle(t *testing.T, email string) *fakeGoogleFor {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "app-auth-kid"
	f := &fakeGoogleFor{}
	mux := http.NewServeMux()
	mux.HandleFunc("/certs", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		nonce := f.nonce
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id_token":     signGoogleIDToken(t, key, kid, testGoogleClientID, email, "App User", nonce),
			"access_token": "ya29.test-access",
		})
	})
	google := httptest.NewServer(mux)
	t.Cleanup(google.Close)

	prevToken, prevCerts, prevHTTP := auth.GoogleTokenURL, auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() {
		auth.GoogleTokenURL = prevToken
		auth.GoogleCertsURL = prevCerts
		auth.GoogleHTTP = prevHTTP
	})
	auth.GoogleTokenURL = google.URL + "/token"
	auth.GoogleCertsURL = google.URL + "/certs"
	auth.GoogleHTTP = google.Client()
	return f
}

func noRedirects(c *http.Client) *http.Client {
	return &http.Client{Jar: c.Jar, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// newVerifier is what the app makes: 32 random bytes, base64url.
func newVerifier(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

/* appGoogleSignIn runs start and callback the way the system browser does, on a client with no
 * cookies of the harness's (the system browser is not the app), and returns the return page's
 * fragment. */
func appGoogleSignIn(t *testing.T, h *harness, g *fakeGoogleFor, app, verifier, next string) url.Values {
	t.Helper()
	browser := noRedirects(&http.Client{})
	q := url.Values{"next": {next}, "app": {app}, "challenge": {api.ChallengeFor(verifier)}}
	res, err := browser.Get(h.srv.URL + "/api/auth/google/start?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("start: status %d", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.nonce = loc.Query().Get("nonce")
	g.mu.Unlock()
	state := loc.Query().Get("state")

	res, err = browser.Get(h.srv.URL + "/api/auth/google/callback?code=test-code&state=" + url.QueryEscape(state))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d", res.StatusCode)
	}
	for _, c := range res.Cookies() {
		if c.Name == "webcast_session" && c.Value != "" {
			t.Fatal("the system browser was given a session cookie")
		}
	}
	back, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if back.Path != "/auth/app-return" || back.RawQuery != "" {
		t.Fatalf("callback went to %s, want /auth/app-return#…", back)
	}
	frag, err := url.ParseQuery(back.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	if frag.Get("app") != app {
		t.Fatalf("return page app %q, want %q", frag.Get("app"), app)
	}
	return frag
}

func (h *harness) exchange(code, verifier string) (*http.Response, []byte) {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/auth/app/exchange", types.AppAuthExchangeRequest{Code: code, Verifier: verifier})
}

func TestAppSignInHandOff(t *testing.T) {
	g := newFakeGoogle(t, "app-user@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	frag := appGoogleSignIn(t, h, g, "ios", verifier, "/webinars/demo")
	code := frag.Get("code")
	if len(code) < 32 || frag.Get("error") != "" {
		t.Fatalf("return fragment %v", frag)
	}
	// The code is stored as a hash, never as itself.
	if n := h.pushCount(`SELECT count(*) FROM app_auth_codes WHERE code_hash = $1`, code); n != 0 {
		t.Fatal("the raw code is in the database")
	}

	// The app's webview has no session until it redeems the code.
	if res, _ := h.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me before exchange: %d", res.StatusCode)
	}
	res, raw := h.exchange(code, verifier)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("exchange: %d %s", res.StatusCode, raw)
	}
	var out types.AppAuthExchangeResponse
	h.decode(raw, &out)
	if out.Account.Email != "app-user@test.dev" || out.Next != "/webinars/demo" {
		t.Fatalf("exchange answer %+v", out)
	}
	if strings.Contains(string(raw), "webcast_session") {
		t.Fatal("the session token is in the response body")
	}
	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me after exchange: %d %s", res.StatusCode, raw)
	}

	// Used once, gone.
	res, raw = h.exchange(code, verifier)
	wantCode(t, res, raw, http.StatusBadRequest, "code_used")
}

func TestAppSignInWrongVerifierBurnsTheCode(t *testing.T) {
	g := newFakeGoogle(t, "stolen@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	code := appGoogleSignIn(t, h, g, "android", verifier, "/").Get("code")

	// Somebody who caught the webinarliv:// link but not the verifier.
	res, raw := h.exchange(code, newVerifier(t))
	wantCode(t, res, raw, http.StatusBadRequest, "invalid_code")
	if res, _ := h.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong verifier signed in: %d", res.StatusCode)
	}
	// The one guess spent it: not even the real app can use it now.
	res, raw = h.exchange(code, verifier)
	wantCode(t, res, raw, http.StatusBadRequest, "code_used")

	// A malformed verifier is refused before the code is looked at.
	code = appGoogleSignIn(t, h, g, "android", verifier, "/").Get("code")
	res, raw = h.exchange(code, "short")
	wantCode(t, res, raw, http.StatusBadRequest, "invalid_code")
	res, raw = h.exchange(code, verifier)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("exchange after a malformed try: %d %s", res.StatusCode, raw)
	}
	// A code nobody issued.
	res, raw = h.exchange(strings.Repeat("ab", 32), verifier)
	wantCode(t, res, raw, http.StatusBadRequest, "invalid_code")
}

func TestAppSignInCodeExpires(t *testing.T) {
	g := newFakeGoogle(t, "slow@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	code := appGoogleSignIn(t, h, g, "desktop", verifier, "/host").Get("code")
	if n := h.pushCount(`SELECT count(*) FROM app_auth_codes
		WHERE expires_at BETWEEN now() + interval '100 seconds' AND now() + interval '121 seconds'`); n != 1 {
		t.Fatalf("codes living about two minutes: %d", n)
	}
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE app_auth_codes SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	res, raw := h.exchange(code, verifier)
	wantCode(t, res, raw, http.StatusBadRequest, "code_expired")
	if res, _ := h.do(http.MethodGet, "/api/auth/me", nil); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired code signed in: %d", res.StatusCode)
	}
}

func TestAppSignInExchangeIsRateLimited(t *testing.T) {
	h := newHarness(t, withGoogleOAuth)
	verifier := newVerifier(t)
	limited := false
	for i := 0; i < 12; i++ {
		res, raw := h.exchange(strings.Repeat("cd", 32), verifier)
		if res.StatusCode == http.StatusTooManyRequests {
			limited = true
			if i < 10 {
				t.Fatalf("limited after %d tries, want 10 a minute", i)
			}
			break
		}
		wantCode(t, res, raw, http.StatusBadRequest, "invalid_code")
	}
	if !limited {
		t.Fatal("twelve exchanges a minute from one IP were all answered")
	}
}

func TestAppSignInStartValidation(t *testing.T) {
	h := newHarness(t, withGoogleOAuth)
	browser := noRedirects(&http.Client{})
	for _, q := range []string{
		"app=ios",                 // no challenge
		"app=ios&challenge=short", // not a SHA-256
		"app=tv&challenge=" + api.ChallengeFor(strings.Repeat("v", 43)), // unknown app
		"challenge=" + api.ChallengeFor(strings.Repeat("v", 43)),        // challenge without an app
	} {
		res, err := browser.Get(h.srv.URL + "/api/auth/google/start?" + q)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("start %s: %d, want 400", q, res.StatusCode)
		}
	}
	// Without the flag it is the web sign-in, unchanged: the callback sets the cookie itself
	// (TestGoogleCallbackCreatesAndSignsIn).
	res, err := browser.Get(h.srv.URL + "/api/auth/google/start?next=/")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("web start: %d", res.StatusCode)
	}
}

// Cancelling at Google, from an app's sign-in, goes back to the app rather than the browser's
// login page.
func TestAppSignInDeniedReturnsToTheApp(t *testing.T) {
	h := newHarness(t, withGoogleOAuth)
	browser := noRedirects(&http.Client{})
	q := url.Values{"app": {"ios"}, "challenge": {api.ChallengeFor(newVerifier(t))}}
	res, err := browser.Get(h.srv.URL + "/api/auth/google/start?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, _ := url.Parse(res.Header.Get("Location"))
	state := loc.Query().Get("state")
	res, err = browser.Get(h.srv.URL + "/api/auth/google/callback?error=access_denied&state=" + url.QueryEscape(state))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	back, _ := url.Parse(res.Header.Get("Location"))
	frag, _ := url.ParseQuery(back.Fragment)
	if back.Path != "/auth/app-return" || frag.Get("error") != "denied" || frag.Get("code") != "" {
		t.Fatalf("denied went to %s", res.Header.Get("Location"))
	}
}
