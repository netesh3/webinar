package api_test

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

const testGoogleClientID = "test-google-client-id.apps.googleusercontent.com"

func TestGoogleStartRedirectsToGoogle(t *testing.T) {
	h := newHarness(t, withGoogleOAuth)

	req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?next=/webinars/demo", nil)
	if err != nil {
		t.Fatal(err)
	}
	noFollow := &http.Client{
		Jar: h.client.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	res, err := noFollow.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("start: status %d, want 302", res.StatusCode)
	}
	loc := res.Header.Get("Location")
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("client_id") != testGoogleClientID {
		t.Fatalf("client_id %q", q.Get("client_id"))
	}
	if q.Get("prompt") != "select_account" {
		t.Fatalf("prompt %q", q.Get("prompt"))
	}
	if q.Get("include_granted_scopes") != "true" {
		t.Fatalf("include_granted_scopes %q", q.Get("include_granted_scopes"))
	}
	if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("missing pkce: %s", loc)
	}
	if q.Get("login_hint") != "" {
		t.Fatalf("empty start must omit login_hint: %s", loc)
	}
	if strings.Contains(loc, "access_type=offline") {
		t.Fatalf("login must not request offline access: %s", loc)
	}
	if !strings.Contains(q.Get("redirect_uri"), "/api/auth/google/callback") {
		t.Fatalf("redirect_uri %q", q.Get("redirect_uri"))
	}
	if q.Get("state") == "" || q.Get("nonce") == "" {
		t.Fatalf("missing state/nonce: %s", loc)
	}
	scope := q.Get("scope")
	if !strings.Contains(scope, "openid") || strings.Contains(scope, "phonenumbers") {
		t.Fatalf("scope %q, want sign-in only and no People phone", scope)
	}
	if strings.Contains(scope, "youtube") {
		t.Fatalf("login must not request YouTube: %s", scope)
	}
}

func TestGoogleStartLoginHint(t *testing.T) {
	h := newHarness(t, withGoogleOAuth)
	noFollow := &http.Client{
		Jar: h.client.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	startQuery := func(rawQuery string) url.Values {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?"+rawQuery, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := noFollow.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusFound {
			t.Fatalf("start: status %d, want 302", res.StatusCode)
		}
		u, err := url.Parse(res.Header.Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		return u.Query()
	}

	q := startQuery("next=/webinars/demo&login_hint=" + url.QueryEscape("user@gmail.com"))
	if q.Get("login_hint") != "user@gmail.com" {
		t.Fatalf("login_hint %q", q.Get("login_hint"))
	}
	if q.Has("prompt") {
		t.Fatalf("hinted prompt %q, want none", q.Get("prompt"))
	}

	q = startQuery("next=/webinars/demo&email=" + url.QueryEscape("alt@gmail.com"))
	if q.Get("login_hint") != "alt@gmail.com" {
		t.Fatalf("email query login_hint %q", q.Get("login_hint"))
	}

	q = startQuery("next=/webinars/demo&login_hint=" + url.QueryEscape("https://evil.example"))
	if q.Get("login_hint") != "" {
		t.Fatalf("junk login_hint %q", q.Get("login_hint"))
	}
	if q.Get("prompt") != "select_account" {
		t.Fatalf("junk prompt %q", q.Get("prompt"))
	}

	q = startQuery("next=/webinars/demo&login_hint=")
	if q.Get("login_hint") != "" {
		t.Fatalf("empty login_hint %q", q.Get("login_hint"))
	}
	if q.Get("prompt") != "select_account" {
		t.Fatalf("empty prompt %q", q.Get("prompt"))
	}
}

func TestGoogleStartUnconfigured(t *testing.T) {
	h := newHarness(t)
	res, raw := h.do(http.MethodGet, "/api/auth/google/start", nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d body %s, want 503", res.StatusCode, raw)
	}
}

func TestGoogleCallbackCreatesAndSignsIn(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "api-google-kid"
	var lastCode, lastRedirect, idNonce string

	mux := http.NewServeMux()
	mux.HandleFunc("/certs", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{
				"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e,
			}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		lastCode = r.Form.Get("code")
		lastRedirect = r.Form.Get("redirect_uri")
		idTok := signGoogleIDToken(t, key, kid, testGoogleClientID, "callback@test.dev", "Callback User", idNonce)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id_token":     idTok,
			"access_token": "ya29.test-access",
		})
	})
	google := httptest.NewServer(mux)
	t.Cleanup(google.Close)

	prevAuth, prevToken, prevCerts, prevHTTP := auth.GoogleAuthURL, auth.GoogleTokenURL, auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() {
		auth.GoogleAuthURL = prevAuth
		auth.GoogleTokenURL = prevToken
		auth.GoogleCertsURL = prevCerts
		auth.GoogleHTTP = prevHTTP
	})
	auth.GoogleTokenURL = google.URL + "/token"
	auth.GoogleCertsURL = google.URL + "/certs"
	auth.GoogleHTTP = google.Client()

	h := newHarness(t, withGoogleOAuth)

	noFollow := &http.Client{
		Jar: h.client.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	start, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?next=/", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := noFollow.Do(start)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	idNonce = loc.Query().Get("nonce")
	if state == "" || idNonce == "" {
		t.Fatalf("start location %s", res.Header.Get("Location"))
	}

	cb, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/callback?code=test-code&state="+url.QueryEscape(state), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err = noFollow.Do(cb)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d body %s", res.StatusCode, body)
	}
	if lastCode != "test-code" {
		t.Fatalf("token code %q", lastCode)
	}
	if !strings.Contains(lastRedirect, "/api/auth/google/callback") {
		t.Fatalf("token redirect %q", lastRedirect)
	}
	if got := res.Header.Get("Location"); !strings.Contains(got, "/my-webinars") {
		t.Fatalf("landed %q", got)
	}

	res, raw := h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.Email != "callback@test.dev" || acct.CanHost {
		t.Fatalf("account %+v", acct)
	}
}

func TestGoogleAuthOneTap(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "one-tap-kid"
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{
				"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e,
			}},
		})
	})
	certs := httptest.NewServer(mux)
	t.Cleanup(certs.Close)

	prevCerts, prevHTTP := auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() {
		auth.GoogleCertsURL = prevCerts
		auth.GoogleHTTP = prevHTTP
	})
	auth.GoogleCertsURL = certs.URL
	auth.GoogleHTTP = certs.Client()

	h := newHarness(t, withGoogleOAuth)
	idTok := signGoogleIDToken(t, key, kid, testGoogleClientID, "onetap@test.dev", "One Tap", "nonce-1")
	res, raw := h.do(http.MethodPost, "/api/auth/google", types.GoogleAuthRequest{
		IDToken: idTok,
		Nonce:   "nonce-1",
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d body %s", res.StatusCode, raw)
	}
	var created types.Account
	h.decode(raw, &created)
	if created.Email != "onetap@test.dev" {
		t.Fatalf("account %+v", created)
	}

	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me: status %d body %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPost, "/api/auth/google", types.GoogleAuthRequest{
		IDToken: signGoogleIDToken(t, key, kid, testGoogleClientID, "onetap@test.dev", "One Tap", "nonce-2"),
		Nonce:   "nonce-2",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("sign-in: status %d body %s", res.StatusCode, raw)
	}
}

/* Continue with Google stores no phone at all. A later registration with a
 * typed number fills the account's phone, and a profile patch can change it. */
func TestGoogleSignInThenTypedRegistrationPhone(t *testing.T) {
	const (
		typedNum = "+919876543210"
		email    = "bothphones@test.dev"
	)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "both-phones-kid"
	var lastCode, lastRedirect, idNonce string

	mux := http.NewServeMux()
	mux.HandleFunc("/certs", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{
				"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e,
			}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		lastCode = r.Form.Get("code")
		lastRedirect = r.Form.Get("redirect_uri")
		idTok := signGoogleIDToken(t, key, kid, testGoogleClientID, email, "Both Phones", idNonce)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id_token":     idTok,
			"access_token": "ya29.both-phones",
		})
	})
	google := httptest.NewServer(mux)
	t.Cleanup(google.Close)

	prevAuth, prevToken, prevCerts, prevHTTP := auth.GoogleAuthURL, auth.GoogleTokenURL, auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() {
		auth.GoogleAuthURL = prevAuth
		auth.GoogleTokenURL = prevToken
		auth.GoogleCertsURL = prevCerts
		auth.GoogleHTTP = prevHTTP
	})
	auth.GoogleTokenURL = google.URL + "/token"
	auth.GoogleCertsURL = google.URL + "/certs"
	auth.GoogleHTTP = google.Client()

	h := newHarness(t, withGoogleOAuth)
	h.signup("Host Both", "host-bothphones@test.dev", true)
	wb := h.newWebinar("Both phones", nil)
	h.logout()

	noFollow := &http.Client{
		Jar: h.client.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	start, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?next=/webinars/"+wb.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := noFollow.Do(start)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	idNonce = loc.Query().Get("nonce")
	if state == "" || idNonce == "" {
		t.Fatalf("start location %s", res.Header.Get("Location"))
	}

	cb, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/callback?code=test-code&state="+url.QueryEscape(state), nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err = noFollow.Do(cb)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d body %s", res.StatusCode, body)
	}
	if lastCode != "test-code" {
		t.Fatalf("token code %q", lastCode)
	}
	if !strings.Contains(lastRedirect, "/api/auth/google/callback") {
		t.Fatalf("token redirect %q", lastRedirect)
	}

	res, raw := h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me after google: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.Phone != "" {
		t.Fatalf("typed phone after google %q, want empty", acct.Phone)
	}
	if acct.GooglePhone != "" {
		t.Fatalf("google phone %q, want none: the phone scope is gone", acct.GooglePhone)
	}

	res, raw = h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/register", types.RegisterRequest{
		FirstName: "Both", LastName: "Phones", Email: email, Consent: true, Phone: typedNum,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("register: status %d body %s", res.StatusCode, raw)
	}
	var reg types.Registration
	h.decode(raw, &reg)
	if reg.Phone != typedNum {
		t.Fatalf("registration phone %q", reg.Phone)
	}

	res, raw = h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me after register: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &acct)
	if acct.Phone != typedNum {
		t.Fatalf("typed phone after register %q", acct.Phone)
	}

	patched := "+12025550143"
	res, raw = h.do(http.MethodPatch, "/api/auth/me", types.ProfilePatch{Phone: &patched})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("patch: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &acct)
	if acct.Phone != patched {
		t.Fatalf("patched phone %q", acct.Phone)
	}
}

func TestGoogleStartCanonicalizesWWW(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) {
		withGoogleOAuth(cfg)
		cfg.WebBaseURL = "https://webinarliv.com"
		cfg.CORSOrigins = []string{"https://webinarliv.com", "https://www.webinarliv.com"}
		cfg.CookieSecure = true
	})
	noFollow := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?next=/webinars/demo", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Host", "www.webinarliv.com")
	req.Header.Set("X-Forwarded-Proto", "https")
	res, err := noFollow.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if got := loc.Query().Get("redirect_uri"); got != "https://webinarliv.com/api/auth/google/callback" {
		t.Fatalf("www start redirect_uri %q, want apex", got)
	}
}

func TestGoogleCallbackPinsStartRedirectWhenHostChanges(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "pin-redirect-kid"
	const preview = "preview.example.workers.dev"
	var lastRedirect, lastVerifier, idNonce string

	mux := http.NewServeMux()
	mux.HandleFunc("/certs", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{
				"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e,
			}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		lastRedirect = r.Form.Get("redirect_uri")
		lastVerifier = r.Form.Get("code_verifier")
		idTok := signGoogleIDToken(t, key, kid, testGoogleClientID, "pin@test.dev", "Pin", idNonce)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id_token":     idTok,
			"access_token": "ya29.pin",
		})
	})
	google := httptest.NewServer(mux)
	t.Cleanup(google.Close)

	prevAuth, prevToken, prevCerts, prevHTTP := auth.GoogleAuthURL, auth.GoogleTokenURL, auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() {
		auth.GoogleAuthURL = prevAuth
		auth.GoogleTokenURL = prevToken
		auth.GoogleCertsURL = prevCerts
		auth.GoogleHTTP = prevHTTP
	})
	auth.GoogleTokenURL = google.URL + "/token"
	auth.GoogleCertsURL = google.URL + "/certs"
	auth.GoogleHTTP = google.Client()

	h := newHarness(t, func(cfg *config.Config) {
		withGoogleOAuth(cfg)
		cfg.WebBaseURL = "https://webinarliv.com"
		cfg.CORSOrigins = []string{"https://webinarliv.com", "https://" + preview}
		cfg.CookieSecure = true
	})
	noFollow := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	start, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?next=/&login_hint="+url.QueryEscape("pin@test.dev"), nil)
	if err != nil {
		t.Fatal(err)
	}
	start.Header.Set("X-Forwarded-Host", preview)
	start.Header.Set("X-Forwarded-Proto", "https")
	res, err := noFollow.Do(start)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	idNonce = loc.Query().Get("nonce")
	wantRedirect := "https://" + preview + "/api/auth/google/callback"
	if loc.Query().Get("redirect_uri") != wantRedirect {
		t.Fatalf("start redirect_uri %q, want %s", loc.Query().Get("redirect_uri"), wantRedirect)
	}
	if loc.Query().Has("prompt") {
		t.Fatalf("hinted prompt %q, want none", loc.Query().Get("prompt"))
	}

	cb, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/callback?code=pin-code&state="+url.QueryEscape(state), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Callback arrives on the apex (dropped/changed X-Forwarded-Host) without
	// the start cookie — the signed state must still carry redirect + PKCE.
	cb.Header.Set("X-Forwarded-Host", "webinarliv.com")
	cb.Header.Set("X-Forwarded-Proto", "https")
	res, err = noFollow.Do(cb)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d body %s", res.StatusCode, body)
	}
	if lastRedirect != wantRedirect {
		t.Fatalf("token redirect_uri %q, want pinned start URI %s", lastRedirect, wantRedirect)
	}
	if lastVerifier == "" {
		t.Fatal("token exchange missing code_verifier")
	}
	if got := res.Header.Get("Location"); strings.Contains(got, "google=") {
		t.Fatalf("landed on fail %q", got)
	}
}

func TestGoogleCallbackSucceedsWhenPeoplePhoneDenied(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "no-phone-kid"
	var idNonce string

	mux := http.NewServeMux()
	mux.HandleFunc("/certs", func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{{
				"kid": kid, "kty": "RSA", "alg": "RS256", "n": n, "e": e,
			}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		idTok := signGoogleIDToken(t, key, kid, testGoogleClientID, "nophone@test.dev", "No Phone", idNonce)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id_token":     idTok,
			"access_token": "ya29.no-phone",
		})
	})
	google := httptest.NewServer(mux)
	t.Cleanup(google.Close)

	prevAuth, prevToken, prevCerts, prevHTTP := auth.GoogleAuthURL, auth.GoogleTokenURL, auth.GoogleCertsURL, auth.GoogleHTTP
	t.Cleanup(func() {
		auth.GoogleAuthURL = prevAuth
		auth.GoogleTokenURL = prevToken
		auth.GoogleCertsURL = prevCerts
		auth.GoogleHTTP = prevHTTP
	})
	auth.GoogleTokenURL = google.URL + "/token"
	auth.GoogleCertsURL = google.URL + "/certs"
	auth.GoogleHTTP = google.Client()

	h := newHarness(t, withGoogleOAuth)
	noFollow := &http.Client{
		Jar: h.client.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	start, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/auth/google/start?next=/", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := noFollow.Do(start)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	idNonce = loc.Query().Get("nonce")

	cb, err := http.NewRequest(http.MethodGet,
		h.srv.URL+"/api/auth/google/callback?code=no-phone&state="+url.QueryEscape(state)+"&error=access_denied", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err = noFollow.Do(cb)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d body %s", res.StatusCode, body)
	}
	if got := res.Header.Get("Location"); strings.Contains(got, "google=") {
		t.Fatalf("phone skip must not fail sign-in: %s", got)
	}

	res, raw := h.do(http.MethodGet, "/api/auth/me", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("me: status %d body %s", res.StatusCode, raw)
	}
	var acct types.Account
	h.decode(raw, &acct)
	if acct.Email != "nophone@test.dev" {
		t.Fatalf("account %+v", acct)
	}
	if acct.GooglePhone != "" {
		t.Fatalf("google phone %q, want empty", acct.GooglePhone)
	}
}

func signGoogleIDToken(t *testing.T, key *rsa.PrivateKey, kid, aud, email, name, nonce string) string {
	t.Helper()
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss":            "https://accounts.google.com",
		"aud":            aud,
		"sub":            "google-" + email,
		"email":          email,
		"email_verified": true,
		"name":           name,
		"nonce":          nonce,
		"iat":            now.Unix(),
		"exp":            now.Add(time.Hour).Unix(),
	})
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
