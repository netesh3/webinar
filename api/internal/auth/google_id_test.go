package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestVerifyGoogleIDToken(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const kid = "test-google-kid"
	const aud = "client.apps.googleusercontent.com"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := base64.RawURLEncoding.EncodeToString(key.N.Bytes())
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(googleJWKS{Keys: []googleJWK{{
			Kid: kid, Kty: "RSA", Alg: "RS256", N: n, E: e,
		}}})
	}))
	t.Cleanup(srv.Close)

	prevURL, prevHTTP := GoogleCertsURL, GoogleHTTP
	t.Cleanup(func() {
		GoogleCertsURL = prevURL
		GoogleHTTP = prevHTTP
		resetGoogleCertsCache()
	})
	GoogleCertsURL = srv.URL
	GoogleHTTP = srv.Client()
	resetGoogleCertsCache()

	sign := func(mut func(jwt.MapClaims)) string {
		now := time.Now()
		claims := jwt.MapClaims{
			"iss":            "https://accounts.google.com",
			"aud":            aud,
			"sub":            "google-sub-1",
			"email":          "Ada@Gmail.com",
			"email_verified": true,
			"name":           "Ada Lovelace",
			"picture":        "https://lh3.googleusercontent.com/a/ada",
			"nonce":          "abc123",
			"iat":            now.Unix(),
			"exp":            now.Add(time.Hour).Unix(),
		}
		if mut != nil {
			mut(claims)
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = kid
		s, err := tok.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	id, err := VerifyGoogleIDToken(sign(nil), aud, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if id.Email != "ada@gmail.com" || id.Name != "Ada Lovelace" || !id.EmailVerified {
		t.Fatalf("identity %+v", id)
	}
	if id.Picture != "https://lh3.googleusercontent.com/a/ada" {
		t.Fatalf("picture %q", id.Picture)
	}

	if _, err := VerifyGoogleIDToken(sign(nil), aud, "wrong"); err == nil {
		t.Fatal("wanted nonce failure")
	}
	if _, err := VerifyGoogleIDToken(sign(nil), "other-client", "abc123"); err == nil {
		t.Fatal("wanted aud failure")
	}
	if _, err := VerifyGoogleIDToken(sign(func(c jwt.MapClaims) {
		c["iss"] = "https://evil.example"
	}), aud, "abc123"); err == nil {
		t.Fatal("wanted issuer failure")
	}
	if _, err := VerifyGoogleIDToken(sign(func(c jwt.MapClaims) {
		c["email"] = ""
	}), aud, "abc123"); err == nil {
		t.Fatal("wanted missing email")
	}
	dropped, err := VerifyGoogleIDToken(sign(func(c jwt.MapClaims) {
		c["picture"] = "https://evil.example/tracker.png"
	}), aud, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if dropped.Picture != "" {
		t.Fatalf("kept off-site picture %q", dropped.Picture)
	}
}
