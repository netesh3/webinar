package auth

import (
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
