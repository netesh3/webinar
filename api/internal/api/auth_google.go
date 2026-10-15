package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

const googleStateCookie = "webcast_google"

type googleOAuthState struct {
	jwt.RegisteredClaims
	Next  string `json:"next"`
	Nonce string `json:"nonce"`
}

func (s *Server) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.GoogleAuthEnabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "google_auth_unavailable",
			"Google sign-in is not configured on this instance.")
		return
	}

	next := safeGoogleNext(r.URL.Query().Get("next"))
	nonce, err := randomNonce()
	if err != nil {
		s.fail(w, r, "google start: nonce", err)
		return
	}
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, googleOAuthState{
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
			Issuer:    "webcast-google",
		},
		Next:  next,
		Nonce: nonce,
	})
	signed, err := tok.SignedString([]byte(s.cfg.SessionSecret))
	if err != nil {
		s.fail(w, r, "google start: sign state", err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     googleStateCookie,
		Value:    signed,
		Path:     "/",
		Expires:  now.Add(10 * time.Minute),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: s.googleSameSite(),
	})

	redirect := s.googleRedirectURI(r)
	http.Redirect(w, r, auth.GoogleAuthCodeURL(s.cfg.GoogleClientID, redirect, signed, nonce), http.StatusFound)
}

func (s *Server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	next := "/"
	fail := func(detail string) {
		s.clearGoogleStateCookie(w)
		dest := s.googleFront(r, "/login", next, detail)
		http.Redirect(w, r, dest, http.StatusFound)
	}

	if gerr := r.URL.Query().Get("error"); gerr != "" {
		if gerr == "access_denied" {
			fail("denied")
			return
		}
		fail("google")
		return
	}

	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if ck, err := r.Cookie(googleStateCookie); err == nil && ck.Value != "" {
		if state != "" && ck.Value != state {
			fail("state")
			return
		}
		if state == "" {
			state = ck.Value
		}
	}
	st, err := s.parseGoogleState(state)
	if err != nil {
		fail("state")
		return
	}
	next = safeGoogleNext(st.Next)

	if !s.cfg.GoogleAuthEnabled() {
		fail("unset")
		return
	}

	tok, err := auth.ExchangeGoogleCode(r.Context(), s.cfg.GoogleClientID, s.cfg.GoogleClientSecret,
		s.googleRedirectURI(r), r.URL.Query().Get("code"))
	if err != nil {
		s.log.Warn("google oauth exchange", "error", err)
		fail("exchange")
		return
	}

	identity, err := auth.VerifyGoogleIDToken(tok.IDToken, s.cfg.GoogleClientID, st.Nonce)
	if err != nil {
		s.log.Warn("google oauth id token", "error", err)
		fail("token")
		return
	}

	user, created, err := s.provisionGoogleUser(r.Context(), identity, tok.AccessToken, "google auth")
	if errors.Is(err, errOAuthSignupClosed) {
		fail("signup")
		return
	}
	if errors.Is(err, errOAuthEmailUnverified) {
		fail("unverified")
		return
	}
	if err != nil {
		s.fail(w, r, "google oauth: account", err)
		return
	}

	session, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "google oauth: issue session", err)
		return
	}
	s.sessions.SetCookie(w, session, exp)
	s.store.TouchLogin(r.Context(), user.ID)
	s.clearGoogleStateCookie(w)
	if created {
		s.queueWelcome(r.Context(), user)
		s.flushMailSoon()
	}
	s.log.Info("google auth", "user", user.ID, "created", created,
		"email_domain", domainOf(user.Email))
	http.Redirect(w, r, s.googleFront(r, landingAfterSignIn(user.CanHost, next), "", ""), http.StatusFound)
}

/* handleGoogleAuth is POST /api/auth/google.
 *
 * Kept for ID-token exchange. The product UI no longer shows One Tap, because
 * that prompt cannot collect a phone number. Continue with Google uses
 * /start and /callback instead.
 */
func (s *Server) handleGoogleAuth(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.GoogleAuthEnabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "google_auth_unavailable",
			"Google sign-in is not configured on this instance.")
		return
	}

	var req types.GoogleAuthRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	identity, err := auth.VerifyGoogleIDToken(req.IDToken, s.cfg.GoogleClientID, req.Nonce)
	if err != nil {
		s.log.Warn("google auth rejected", "error", err, "ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusUnauthorized, "invalid_token",
			"That Google sign-in could not be verified. Try again.")
		return
	}

	user, created, err := s.provisionGoogleUser(r.Context(), identity, "", "google auth")
	if errors.Is(err, errOAuthSignupClosed) {
		httpx.Error(w, http.StatusForbidden, "signup_closed",
			"New accounts are closed on this instance.")
		return
	}
	if errors.Is(err, errOAuthEmailUnverified) {
		httpx.Error(w, http.StatusForbidden, "email_unverified", verifyEmailMessage)
		return
	}
	if err != nil {
		s.fail(w, r, "google auth: account", err)
		return
	}

	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "google auth: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)
	s.store.TouchLogin(r.Context(), user.ID)
	s.log.Info("google auth", "user", user.ID, "created", created,
		"email_domain", domainOf(user.Email))
	status := http.StatusOK
	if created {
		status = http.StatusCreated
		s.queueWelcome(r.Context(), user)
		s.flushMailSoon()
	}
	httpx.JSON(w, status, user.Public())
}

func (s *Server) googleSameSite() http.SameSite {
	if s.cfg.CookieSecure {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func (s *Server) clearGoogleStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: googleStateCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: s.googleSameSite(),
	})
}

func (s *Server) parseGoogleState(raw string) (googleOAuthState, error) {
	var st googleOAuthState
	_, err := jwt.ParseWithClaims(raw, &st,
		func(t *jwt.Token) (any, error) { return []byte(s.cfg.SessionSecret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer("webcast-google"),
		jwt.WithExpirationRequired(),
	)
	if err != nil || st.Nonce == "" {
		return googleOAuthState{}, errors.New("invalid google oauth state")
	}
	return st, nil
}

func (s *Server) googleRedirectURI(r *http.Request) string {
	return s.googleOrigin(r) + "/api/auth/google/callback"
}

func (s *Server) googleFront(r *http.Request, path, next, detail string) string {
	u, err := url.Parse(s.googleOrigin(r) + path)
	if err != nil {
		u, _ = url.Parse(strings.TrimRight(s.cfg.WebBaseURL, "/") + path)
	}
	q := u.Query()
	if next != "" && path == "/login" {
		q.Set("next", next)
	}
	if detail != "" {
		q.Set("google", detail)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func (s *Server) googleOrigin(r *http.Request) string {
	host := firstForwarded(r.Header.Get("X-Forwarded-Host"))
	proto := firstForwarded(r.Header.Get("X-Forwarded-Proto"))
	if host == "" {
		host = r.Host
	}
	if proto == "" {
		if r.TLS != nil || s.cfg.CookieSecure {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	origin := proto + "://" + host
	if s.webOriginAllowed(origin) {
		return origin
	}
	if s.cfg.IsDev() && host != "" {
		return origin
	}
	return strings.TrimRight(s.cfg.WebBaseURL, "/")
}

func (s *Server) webOriginAllowed(origin string) bool {
	want := strings.TrimRight(strings.ToLower(origin), "/")
	if strings.TrimRight(strings.ToLower(s.cfg.WebBaseURL), "/") == want {
		return true
	}
	for _, o := range s.cfg.CORSOrigins {
		if strings.TrimRight(strings.ToLower(o), "/") == want {
			return true
		}
	}
	return false
}

func firstForwarded(raw string) string {
	raw = strings.TrimSpace(raw)
	if i := strings.Index(raw, ","); i >= 0 {
		raw = strings.TrimSpace(raw[:i])
	}
	return raw
}

func safeGoogleNext(raw string) string {
	p := strings.TrimSpace(raw)
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.Contains(p, "://") {
		return "/"
	}
	if i := strings.IndexAny(p, "\r\n"); i >= 0 {
		p = p[:i]
	}
	return p
}

func landingAfterSignIn(canHost bool, next string) string {
	path := next
	if i := strings.Index(next, "?"); i >= 0 {
		path = next[:i]
	}
	if path == "" || path == "/" || path == "/browse" {
		if canHost {
			return "/host"
		}
		return "/my-webinars"
	}
	return next
}

func randomNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *Server) supabaseBrowserAuthEnabled() bool {
	return strings.TrimSpace(s.cfg.SupabaseURL) != "" && strings.TrimSpace(s.cfg.SupabaseAnonKey) != ""
}

var (
	errOAuthSignupClosed    = errors.New("oauth signup closed")
	errOAuthEmailUnverified = errors.New("oauth email unverified")
)

func (s *Server) provisionGoogleUser(ctx context.Context, identity auth.GoogleIdentity, googleAccessToken, logName string) (store.User, bool, error) {
	user, err := s.store.UserByEmail(ctx, identity.Email)
	created := false
	switch {
	case err == nil:
	case errors.Is(err, store.ErrNotFound):
		if !s.cfg.SignupOpen {
			return store.User{}, false, errOAuthSignupClosed
		}
		user, err = s.store.CreateUser(ctx, identity.Email, "",
			identity.Name, "", "", "", false)
		if errors.Is(err, store.ErrConflict) {
			user, err = s.store.UserByEmail(ctx, identity.Email)
		}
		if err != nil {
			return store.User{}, false, err
		}
		created = true
	default:
		return store.User{}, false, err
	}

	if googlePhone := s.optionalGooglePhone(ctx, googleAccessToken); googlePhone != "" {
		updated, uerr := s.store.SetGooglePhone(ctx, user.ID, googlePhone)
		if uerr != nil {
			s.log.Warn(logName+": save google phone", "user", user.ID, "error", uerr)
		} else {
			user = updated
		}
	}

	if pic := identity.Picture; pic != "" && pic != user.GooglePicture {
		if err := s.store.SetGooglePicture(ctx, user.ID, pic); err != nil {
			s.log.Warn(logName+": picture", "error", err, "user", user.ID)
		} else {
			user.GooglePicture = pic
		}
	}

	if identity.EmailVerified {
		if !user.EmailVerified() {
			if err := s.store.MarkEmailVerified(ctx, user.ID); err != nil {
				return store.User{}, created, err
			}
			now := time.Now()
			user.EmailVerifiedAt = &now
		}
	} else if !user.EmailVerified() {
		s.queueEmailVerification(ctx, user)
		if created {
			s.queueWelcome(ctx, user)
		}
		s.flushMailSoon()
		return store.User{}, created, errOAuthEmailUnverified
	}

	return user, created, nil
}
