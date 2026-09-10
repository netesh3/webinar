package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestVerifySupabaseAccessToken(t *testing.T) {
	secret := "test-supabase-jwt-secret-not-for-production"
	url := "https://example.supabase.co"

	sign := func(mut func(*supabaseClaims)) string {
		t.Helper()
		now := time.Now()
		c := &supabaseClaims{
			RegisteredClaims: jwt.RegisteredClaims{
				Subject:   "11111111-1111-1111-1111-111111111111",
				Issuer:    url + "/auth/v1",
				Audience:  jwt.ClaimStrings{"authenticated"},
				IssuedAt:  jwt.NewNumericDate(now),
				ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			},
			Email: "Ada.Lovelace@Example.com",
			Role:  "authenticated",
			UserMetadata: map[string]any{
				"full_name": "Ada Lovelace",
			},
		}
		if mut != nil {
			mut(c)
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
		s, err := tok.SignedString([]byte(secret))
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	t.Run("ok", func(t *testing.T) {
		id, err := VerifySupabaseAccessToken(sign(nil), secret, url)
		if err != nil {
			t.Fatal(err)
		}
		if id.Email != "ada.lovelace@example.com" {
			t.Fatalf("email %q", id.Email)
		}
		if id.Name != "Ada Lovelace" {
			t.Fatalf("name %q", id.Name)
		}
		if id.Subject == "" {
			t.Fatal("missing subject")
		}
	})

	t.Run("wrong secret", func(t *testing.T) {
		if _, err := VerifySupabaseAccessToken(sign(nil), "other", url); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("expired", func(t *testing.T) {
		tok := sign(func(c *supabaseClaims) {
			c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
		})
		if _, err := VerifySupabaseAccessToken(tok, secret, url); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("wrong issuer", func(t *testing.T) {
		tok := sign(func(c *supabaseClaims) {
			c.Issuer = "https://other.supabase.co/auth/v1"
		})
		if _, err := VerifySupabaseAccessToken(tok, secret, url); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("anon role rejected", func(t *testing.T) {
		tok := sign(func(c *supabaseClaims) {
			c.Role = "anon"
		})
		if _, err := VerifySupabaseAccessToken(tok, secret, url); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("missing email", func(t *testing.T) {
		tok := sign(func(c *supabaseClaims) {
			c.Email = ""
		})
		if _, err := VerifySupabaseAccessToken(tok, secret, url); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("name from email local part", func(t *testing.T) {
		tok := sign(func(c *supabaseClaims) {
			c.UserMetadata = nil
			c.Email = "host@acme.dev"
		})
		id, err := VerifySupabaseAccessToken(tok, secret, url)
		if err != nil {
			t.Fatal(err)
		}
		if id.Name != "host" {
			t.Fatalf("name %q", id.Name)
		}
	})
}

func TestVerifySupabaseAccessTokenES256JWKS(t *testing.T) {
	clearSupabaseJWKSCache()
	t.Cleanup(clearSupabaseJWKSCache)

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	kid := "test-es256-kid"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/.well-known/jwks.json" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(jwksDoc{Keys: []jwkKey{{
			Kid: kid,
			Kty: "EC",
			Alg: "ES256",
			Crv: "P-256",
			X:   base64.RawURLEncoding.EncodeToString(padEC(priv.X)),
			Y:   base64.RawURLEncoding.EncodeToString(padEC(priv.Y)),
		}}})
	}))
	t.Cleanup(srv.Close)

	prev := jwksHTTP
	jwksHTTP = srv.Client()
	t.Cleanup(func() { jwksHTTP = prev })

	now := time.Now()
	c := &supabaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "22222222-2222-2222-2222-222222222222",
			Issuer:    srv.URL + "/auth/v1",
			Audience:  jwt.ClaimStrings{"authenticated"},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
		Email: "es256@example.com",
		Role:  "authenticated",
		UserMetadata: map[string]any{
			"name": "ES User",
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, c)
	tok.Header["kid"] = kid
	signed, err := tok.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}

	id, err := VerifySupabaseAccessToken(signed, "", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if id.Email != "es256@example.com" || id.Name != "ES User" {
		t.Fatalf("got %+v", id)
	}

	// Wrong key must fail.
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	bad, err := tok.SignedString(other)
	if err != nil {
		t.Fatal(err)
	}
	clearSupabaseJWKSCache()
	if _, err := VerifySupabaseAccessToken(bad, "", srv.URL); err == nil {
		t.Fatal("expected signature failure")
	}
}

func padEC(n *big.Int) []byte {
	b := n.Bytes()
	if len(b) >= 32 {
		return b
	}
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}
