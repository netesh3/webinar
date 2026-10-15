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
	if q.Get("prompt") != "select_account consent" {
		t.Fatalf("prompt %q", q.Get("prompt"))
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
	if !strings.Contains(scope, "openid") || !strings.Contains(scope, "user.phonenumbers.read") {
		t.Fatalf("scope %q", scope)
	}
	if strings.Contains(scope, "youtube") {
		t.Fatalf("login must not request YouTube: %s", scope)
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

/* Continue with Google stores People on google_phone. A later registration
 * with a different typed number fills phone and leaves google_phone alone. */
func TestGooglePhoneKeptBesideTypedRegistration(t *testing.T) {
	const (
		googleNum = "+14155552671"
		typedNum  = "+919876543210"
		email     = "bothphones@test.dev"
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

	usePeopleAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") != "ya29.both-phones" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, `{"phoneNumbers":[{"canonicalForm":"`+googleNum+`","metadata":{"primary":true}}]}`)
	})

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
	if acct.GooglePhone != googleNum {
		t.Fatalf("google phone %q, want %s", acct.GooglePhone, googleNum)
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
	if acct.GooglePhone != googleNum {
		t.Fatalf("google phone after register %q", acct.GooglePhone)
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
	if acct.GooglePhone != googleNum {
		t.Fatalf("google phone after patch %q", acct.GooglePhone)
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
