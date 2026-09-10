package auth

import (
	"errors"
	"fmt"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidSupabaseToken means the access token is missing, expired, forged, or
// not an authenticated Supabase session.
var ErrInvalidSupabaseToken = errors.New("invalid supabase token")

// SupabaseIdentity is the slice of a verified Supabase access token this app needs
// to create or link a local users row.
type SupabaseIdentity struct {
	Subject string
	Email   string
	Name    string
}

type supabaseClaims struct {
	jwt.RegisteredClaims
	Email        string         `json:"email"`
	Phone        string         `json:"phone"`
	Role         string         `json:"role"`
	UserMetadata map[string]any `json:"user_metadata"`
	AppMetadata  map[string]any `json:"app_metadata"`
}

// VerifySupabaseAccessToken checks a Supabase Auth access token (HS256 JWT secret).
//
// supabaseURL is the project URL (https://<ref>.supabase.co). The issuer claim must
// match {url}/auth/v1. jwtSecret is Project Settings → API → JWT Secret (legacy
// symmetric key). Newer asymmetric signing keys are not handled here — use the
// legacy JWT secret, or extend this verifier for JWKS.
func VerifySupabaseAccessToken(accessToken, jwtSecret, supabaseURL string) (SupabaseIdentity, error) {
	if strings.TrimSpace(accessToken) == "" {
		return SupabaseIdentity{}, ErrInvalidSupabaseToken
	}
	if strings.TrimSpace(jwtSecret) == "" {
		return SupabaseIdentity{}, fmt.Errorf("%w: jwt secret not configured", ErrInvalidSupabaseToken)
	}

	issuer := strings.TrimRight(strings.TrimSpace(supabaseURL), "/") + "/auth/v1"

	parsed, err := jwt.ParseWithClaims(accessToken, &supabaseClaims{},
		func(t *jwt.Token) (any, error) { return []byte(jwtSecret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithAudience("authenticated"),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return SupabaseIdentity{}, errors.Join(ErrInvalidSupabaseToken, err)
	}

	c, ok := parsed.Claims.(*supabaseClaims)
	if !ok || c.Subject == "" {
		return SupabaseIdentity{}, ErrInvalidSupabaseToken
	}
	if c.Role != "" && c.Role != "authenticated" {
		return SupabaseIdentity{}, fmt.Errorf("%w: role %q", ErrInvalidSupabaseToken, c.Role)
	}

	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return SupabaseIdentity{}, fmt.Errorf("%w: missing email", ErrInvalidSupabaseToken)
	}

	return SupabaseIdentity{
		Subject: c.Subject,
		Email:   email,
		Name:    nameFromSupabaseClaims(c),
	}, nil
}

func nameFromSupabaseClaims(c *supabaseClaims) string {
	if c == nil {
		return ""
	}
	for _, key := range []string{"full_name", "name", "preferred_username"} {
		if v, ok := c.UserMetadata[key].(string); ok {
			if name := strings.TrimSpace(v); name != "" {
				return name
			}
		}
	}
	// Fall back to the local part of the email rather than an empty name — the
	// users.name column is NOT NULL and the signup form would have asked for one.
	if at := strings.IndexByte(c.Email, '@'); at > 0 {
		return c.Email[:at]
	}
	return "Google user"
}
