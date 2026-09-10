package auth

import (
	"errors"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const CookieName = "webcast_session"

var ErrInvalidSession = errors.New("invalid session")

// Sessions issues and verifies host session cookies.
//
// HS256 with a server-side secret: this is a first-party cookie for our own API
// only, so there is no key-distribution problem that would justify asymmetric
// signing.
type Sessions struct {
	secret []byte
	ttl    time.Duration
	secure bool
}

func NewSessions(secret string, ttl time.Duration, secure bool) *Sessions {
	return &Sessions{secret: []byte(secret), ttl: ttl, secure: secure}
}

type claims struct {
	jwt.RegisteredClaims
}

// Issue returns a signed session token for a user id.
func (s *Sessions) Issue(userID string) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(s.ttl)
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    "webcast",
		},
	})
	signed, err := tok.SignedString(s.secret)
	return signed, exp, err
}

// Verify returns the user id carried by a session token.
func (s *Sessions) Verify(token string) (string, error) {
	parsed, err := jwt.ParseWithClaims(token, &claims{},
		func(t *jwt.Token) (any, error) { return s.secret, nil },
		// Pin the algorithm. Without this, a token with alg:none or a
		// substituted algorithm could be accepted.
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer("webcast"),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return "", errors.Join(ErrInvalidSession, err)
	}
	c, ok := parsed.Claims.(*claims)
	if !ok || c.Subject == "" {
		return "", ErrInvalidSession
	}
	return c.Subject, nil
}

func (s *Sessions) SetCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true, // not readable from JS, so XSS can't exfiltrate it
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Sessions) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.secure,
		SameSite: http.SameSiteLaxMode,
	})
}
