package auth

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidGoogleToken means the ID token is missing, expired, forged, or
// not issued for this OAuth client.
var ErrInvalidGoogleToken = errors.New("invalid google token")

// GoogleIdentity is the slice of a verified Google ID token this app needs
// to create or link a local users row.
type GoogleIdentity struct {
	Subject string
	Email   string
	Name    string
	Picture string
	/* EmailVerified is whether Google already confirmed the address.
	 *
	 * Absent or true still signs in (Google does not issue an ID token for an
	 * unconfirmed mailbox in the usual login grant). An explicit false is the
	 * exception and is not signed in.
	 */
	EmailVerified bool
}

// GoogleCertsURL is Google's JWKS. Tests point it at an httptest server.
var GoogleCertsURL = "https://www.googleapis.com/oauth2/v3/certs"

// GoogleHTTP fetches certs and token responses. Timeout is short so a slow
// Google cannot hold a sign-in request open.
var GoogleHTTP = &http.Client{Timeout: 10 * time.Second}

var googleIssuers = []string{
	"https://accounts.google.com",
	"accounts.google.com",
}

type googleClaims struct {
	jwt.RegisteredClaims
	Email         string `json:"email"`
	EmailVerified any    `json:"email_verified"`
	Name          string `json:"name"`
	GivenName     string `json:"given_name"`
	FamilyName    string `json:"family_name"`
	Picture       string `json:"picture"`
	Nonce         string `json:"nonce"`
}

type googleJWKS struct {
	Keys []googleJWK `json:"keys"`
}

type googleJWK struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type googleCertsEntry struct {
	fetched time.Time
	keys    map[string]*rsa.PublicKey
}

var (
	googleCertsMu    sync.Mutex
	googleCertsCache = map[string]googleCertsEntry{}
)

const googleCertsTTL = 10 * time.Minute

/* VerifyGoogleIDToken checks a Google ID token (authorization-code or One Tap).
 *
 * audience is this app's OAuth client id. nonce, when non-empty, must match
 * the token's nonce claim (the hashed value GIS was given, or the raw value
 * sent on the authorize URL).
 */
func VerifyGoogleIDToken(raw, audience, nonce string) (GoogleIdentity, error) {
	raw = strings.TrimSpace(raw)
	audience = strings.TrimSpace(audience)
	if raw == "" || audience == "" {
		return GoogleIdentity{}, ErrInvalidGoogleToken
	}

	parsed, err := jwt.ParseWithClaims(raw, &googleClaims{},
		func(t *jwt.Token) (any, error) {
			if t.Method.Alg() != jwt.SigningMethodRS256.Alg() {
				return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
			}
			kid, _ := t.Header["kid"].(string)
			return lookupGoogleRSA(kid)
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return GoogleIdentity{}, errors.Join(ErrInvalidGoogleToken, err)
	}

	c, ok := parsed.Claims.(*googleClaims)
	if !ok || c.Subject == "" {
		return GoogleIdentity{}, ErrInvalidGoogleToken
	}
	if !issuerAllowed(c.Issuer, googleIssuers) {
		return GoogleIdentity{}, fmt.Errorf("%w: issuer %q", ErrInvalidGoogleToken, c.Issuer)
	}

	wantNonce := strings.TrimSpace(nonce)
	gotNonce := strings.TrimSpace(c.Nonce)
	if wantNonce != "" && gotNonce != wantNonce {
		return GoogleIdentity{}, fmt.Errorf("%w: nonce", ErrInvalidGoogleToken)
	}

	email := strings.ToLower(strings.TrimSpace(c.Email))
	if email == "" {
		return GoogleIdentity{}, fmt.Errorf("%w: missing email", ErrInvalidGoogleToken)
	}

	return GoogleIdentity{
		Subject:       c.Subject,
		Email:         email,
		Name:          nameFromGoogleClaims(c),
		Picture:       sanitizePictureURL(c.Picture),
		EmailVerified: googleEmailVerified(c.EmailVerified),
	}, nil
}

func nameFromGoogleClaims(c *googleClaims) string {
	if c == nil {
		return ""
	}
	if n := strings.TrimSpace(c.Name); n != "" {
		return n
	}
	given := strings.TrimSpace(c.GivenName)
	family := strings.TrimSpace(c.FamilyName)
	return strings.TrimSpace(given + " " + family)
}

func googleEmailVerified(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		if s == "false" || s == "0" {
			return false
		}
		return true
	default:
		return true
	}
}

func lookupGoogleRSA(kid string) (*rsa.PublicKey, error) {
	keys, err := googleCerts()
	if err != nil {
		return nil, err
	}
	if kid != "" {
		if k := keys[kid]; k != nil {
			return k, nil
		}
	}
	if k := keys[""]; k != nil && len(keys) == 1 {
		return k, nil
	}
	return nil, fmt.Errorf("google jwks: unknown kid %q", kid)
}

func googleCerts() (map[string]*rsa.PublicKey, error) {
	googleCertsMu.Lock()
	defer googleCertsMu.Unlock()

	url := GoogleCertsURL
	if ent, ok := googleCertsCache[url]; ok && time.Since(ent.fetched) < googleCertsTTL {
		return ent.keys, nil
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := GoogleHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google jwks: HTTP %d", res.StatusCode)
	}

	var doc googleJWKS
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if !strings.EqualFold(k.Kty, "RSA") {
			continue
		}
		pub, err := rsaPublicFromJWK(k.N, k.E)
		if err != nil {
			continue
		}
		if k.Kid != "" {
			keys[k.Kid] = pub
		} else if keys[""] == nil {
			keys[""] = pub
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("google jwks: no RSA keys")
	}
	googleCertsCache[url] = googleCertsEntry{fetched: time.Now(), keys: keys}
	return keys, nil
}

func rsaPublicFromJWK(nB64, eB64 string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil || len(nBytes) == 0 {
		return nil, fmt.Errorf("jwk n")
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil || len(eBytes) == 0 {
		return nil, fmt.Errorf("jwk e")
	}
	e := 0
	for _, b := range eBytes {
		e = e<<8 + int(b)
	}
	if e < 3 {
		return nil, fmt.Errorf("jwk e")
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: e}, nil
}

func resetGoogleCertsCache() {
	googleCertsMu.Lock()
	googleCertsCache = map[string]googleCertsEntry{}
	googleCertsMu.Unlock()
}
