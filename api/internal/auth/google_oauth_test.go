package auth

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
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

	tok, err := ExchangeGoogleCode(context.Background(), "cid", "secret", "http://localhost/cb", "abc")
	if err != nil {
		t.Fatal(err)
	}
	if tok.IDToken != "idt" || tok.AccessToken != "ya29.x" {
		t.Fatalf("%+v", tok)
	}

	if _, err := ExchangeGoogleCode(context.Background(), "cid", "secret", "http://localhost/cb", ""); err == nil {
		t.Fatal("wanted missing code")
	}
}

func TestGoogleAuthCodeURL(t *testing.T) {
	u := GoogleAuthCodeURL("cid", "http://localhost/cb", "state-1", "nonce-1")
	for _, part := range []string{"client_id=cid", "state=state-1", "nonce=nonce-1", "prompt=select_account"} {
		if !strings.Contains(u, part) {
			t.Fatalf("missing %q in %s", part, u)
		}
	}
	if strings.Contains(u, "access_type=offline") {
		t.Fatalf("login URL must not request offline access: %s", u)
	}
}
