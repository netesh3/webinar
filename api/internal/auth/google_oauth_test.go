package auth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestExchangeGoogleCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "code=abc") {
			t.Errorf("form %s", body)
		}
		if !strings.Contains(string(body), "code_verifier=pkce-verifier") {
			t.Errorf("missing verifier: %s", body)
		}
		_, _ = io.WriteString(w, `{"id_token":"idt","access_token":"ya29.x"}`)
	}))
	t.Cleanup(srv.Close)

	prevURL, prevHTTP := GoogleTokenURL, GoogleHTTP
	t.Cleanup(func() {
		GoogleTokenURL = prevURL
		GoogleHTTP = prevHTTP
	})
	GoogleTokenURL = srv.URL
	GoogleHTTP = srv.Client()

	tok, err := ExchangeGoogleCode(context.Background(), "cid", "secret", "http://localhost/cb", "abc", "pkce-verifier")
	if err != nil {
		t.Fatal(err)
	}
	if tok.IDToken != "idt" || tok.AccessToken != "ya29.x" {
		t.Fatalf("%+v", tok)
	}

	if _, err := ExchangeGoogleCode(context.Background(), "cid", "secret", "http://localhost/cb", "", ""); err == nil {
		t.Fatal("wanted missing code")
	}
}

func TestExchangeGoogleCodeKeepsGoogleErrorCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"redirect_uri_mismatch","error_description":"Bad Request"}`)
	}))
	t.Cleanup(srv.Close)
	prevURL, prevHTTP := GoogleTokenURL, GoogleHTTP
	t.Cleanup(func() {
		GoogleTokenURL = prevURL
		GoogleHTTP = prevHTTP
	})
	GoogleTokenURL = srv.URL
	GoogleHTTP = srv.Client()

	_, err := ExchangeGoogleCode(context.Background(), "cid", "secret", "https://www.example/cb", "abc", "v")
	if err == nil || !strings.Contains(err.Error(), "redirect_uri_mismatch") {
		t.Fatalf("error %v, want redirect_uri_mismatch", err)
	}
}

func TestGoogleAuthCodeURL(t *testing.T) {
	raw := GoogleAuthCodeURL("cid", "http://localhost/cb", "state-1", "nonce-1", "", "challenge-1")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("client_id") != "cid" || q.Get("state") != "state-1" || q.Get("nonce") != "nonce-1" {
		t.Fatalf("query %s", raw)
	}
	if q.Get("prompt") != "select_account" {
		t.Fatalf("prompt %q", q.Get("prompt"))
	}
	if q.Get("login_hint") != "" {
		t.Fatalf("empty hint must omit login_hint: %s", raw)
	}
	scope := q.Get("scope")
	if !strings.Contains(scope, "openid") || strings.Contains(scope, "phonenumbers") {
		t.Fatalf("login must request sign-in scopes and no People phone: %s", scope)
	}
	if strings.Contains(scope, "youtube") {
		t.Fatalf("login must not request YouTube Connect: %s", scope)
	}
	if q.Get("access_type") == "offline" {
		t.Fatalf("login URL must not request offline access: %s", raw)
	}
	if q.Has("enable_granular_consent") {
		t.Fatalf("must not toggle granular consent: %s", raw)
	}
	if q.Get("include_granted_scopes") != "true" {
		t.Fatalf("include_granted_scopes %q", q.Get("include_granted_scopes"))
	}
	if q.Get("code_challenge") != "challenge-1" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("pkce %s", raw)
	}

	hinted := GoogleAuthCodeURL("cid", "http://localhost/cb", "state-1", "nonce-1", "  user@gmail.com  ", "")
	hq, err := url.Parse(hinted)
	if err != nil {
		t.Fatal(err)
	}
	q = hq.Query()
	if q.Get("login_hint") != "user@gmail.com" {
		t.Fatalf("login_hint %q", q.Get("login_hint"))
	}
	if q.Has("prompt") {
		t.Fatalf("hinted prompt %q, want none", q.Get("prompt"))
	}

	junk := GoogleAuthCodeURL("cid", "http://localhost/cb", "state-1", "nonce-1", "https://evil.example/phish", "")
	jq, err := url.Parse(junk)
	if err != nil {
		t.Fatal(err)
	}
	if jq.Query().Get("login_hint") != "" {
		t.Fatalf("junk must not become login_hint: %s", junk)
	}
	if jq.Query().Get("prompt") != "select_account" {
		t.Fatalf("junk prompt %q", jq.Query().Get("prompt"))
	}
}

func TestNewGooglePKCE(t *testing.T) {
	a, err := NewGooglePKCE()
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewGooglePKCE()
	if err != nil {
		t.Fatal(err)
	}
	if a.Verifier == "" || a.Challenge == "" || a.Verifier == a.Challenge {
		t.Fatalf("%+v", a)
	}
	if a.Verifier == b.Verifier || a.Challenge == b.Challenge {
		t.Fatal("pkce pair must be unique")
	}
}

func TestGoogleLoginHint(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"  user@gmail.com  ", "user@gmail.com"},
		{"not-an-email", ""},
		{"https://evil.example/phish", ""},
		{"user@gmail.com\nLocation: https://evil.example", ""},
		{"Name <user@gmail.com>", ""},
		{"user@gmail.com", "user@gmail.com"},
		{"a@" + strings.Repeat("x", 260) + ".com", ""},
	}
	for _, c := range cases {
		if got := GoogleLoginHint(c.in); got != c.want {
			t.Errorf("GoogleLoginHint(%q)=%q, want %q", c.in, got, c.want)
		}
	}
}
