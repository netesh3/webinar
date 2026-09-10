package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

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

// jwksHTTP is overridden in tests.
var jwksHTTP = http.DefaultClient

type jwksCacheEntry struct {
	fetched time.Time
	keys    map[string]*ecdsa.PublicKey // kid -> key; "" = first/only
}

var (
	jwksMu    sync.Mutex
	jwksCache = map[string]jwksCacheEntry{}
)

const jwksTTL = 10 * time.Minute

type jwksDoc struct {
	Keys []jwkKey `json:"keys"`
}

type jwkKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

/* VerifySupabaseAccessToken checks a Supabase Auth access token.

 * Modern Supabase projects sign access tokens with ES256 and publish the public
 * key at {supabaseURL}/auth/v1/.well-known/jwks.json. Older projects (and some
 * rotated setups) still use the legacy HS256 JWT secret from Project Settings.
 *
 * We accept both: pick the verifier from the token's alg header. jwtSecret may
 * be empty when only asymmetric keys are in use.
 */
func VerifySupabaseAccessToken(accessToken, jwtSecret, supabaseURL string) (SupabaseIdentity, error) {
	if strings.TrimSpace(accessToken) == "" {
		return SupabaseIdentity{}, ErrInvalidSupabaseToken
	}
	supabaseURL = strings.TrimRight(strings.TrimSpace(supabaseURL), "/")
	if supabaseURL == "" {
		return SupabaseIdentity{}, fmt.Errorf("%w: supabase url not configured", ErrInvalidSupabaseToken)
	}

	issuer := supabaseURL + "/auth/v1"

	parsed, err := jwt.ParseWithClaims(accessToken, &supabaseClaims{},
		func(t *jwt.Token) (any, error) {
			switch t.Method.Alg() {
			case jwt.SigningMethodHS256.Alg():
				if strings.TrimSpace(jwtSecret) == "" {
					return nil, fmt.Errorf("HS256 token but SUPABASE_JWT_SECRET is empty")
				}
				return []byte(jwtSecret), nil
			case jwt.SigningMethodES256.Alg():
				kid, _ := t.Header["kid"].(string)
				return lookupSupabaseECDSA(supabaseURL, kid)
			default:
				return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
			}
		},
		jwt.WithValidMethods([]string{
			jwt.SigningMethodHS256.Alg(),
			jwt.SigningMethodES256.Alg(),
		}),
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

func lookupSupabaseECDSA(supabaseURL, kid string) (*ecdsa.PublicKey, error) {
	keys, err := supabaseJWKS(supabaseURL)
	if err != nil {
		return nil, err
	}
	if kid != "" {
		if k, ok := keys[kid]; ok {
			return k, nil
		}
		return nil, fmt.Errorf("jwks: no key for kid %q", kid)
	}
	if k, ok := keys[""]; ok {
		return k, nil
	}
	for _, k := range keys {
		return k, nil
	}
	return nil, fmt.Errorf("jwks: empty key set")
}

func supabaseJWKS(supabaseURL string) (map[string]*ecdsa.PublicKey, error) {
	jwksMu.Lock()
	defer jwksMu.Unlock()

	if e, ok := jwksCache[supabaseURL]; ok && time.Since(e.fetched) < jwksTTL {
		return e.keys, nil
	}

	url := supabaseURL + "/auth/v1/.well-known/jwks.json"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := jwksHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("jwks fetch: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks fetch: HTTP %d", res.StatusCode)
	}
	var doc jwksDoc
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("jwks decode: %w", err)
	}

	keys := map[string]*ecdsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" {
			continue
		}
		pub, err := ecPublicKeyFromJWK(k.X, k.Y)
		if err != nil {
			return nil, err
		}
		if k.Kid != "" {
			keys[k.Kid] = pub
		}
		if _, ok := keys[""]; !ok {
			keys[""] = pub
		}
	}
	if len(keys) == 0 {
		return nil, fmt.Errorf("jwks: no usable EC P-256 keys")
	}
	jwksCache[supabaseURL] = jwksCacheEntry{fetched: time.Now(), keys: keys}
	return keys, nil
}

func ecPublicKeyFromJWK(xB64, yB64 string) (*ecdsa.PublicKey, error) {
	x, err := base64.RawURLEncoding.DecodeString(xB64)
	if err != nil {
		return nil, fmt.Errorf("jwk x: %w", err)
	}
	y, err := base64.RawURLEncoding.DecodeString(yB64)
	if err != nil {
		return nil, fmt.Errorf("jwk y: %w", err)
	}
	return &ecdsa.PublicKey{
		Curve: elliptic.P256(),
		X:     new(big.Int).SetBytes(x),
		Y:     new(big.Int).SetBytes(y),
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

// clearSupabaseJWKSCache is for tests.
func clearSupabaseJWKSCache() {
	jwksMu.Lock()
	defer jwksMu.Unlock()
	jwksCache = map[string]jwksCacheEntry{}
}
