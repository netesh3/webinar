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
	/* App and Challenge are set when the sign-in started inside the desktop or mobile app
	 * (auth_app.go): the callback then hands the app a one-time code instead of setting the
	 * session cookie in the system browser. */
	App       string `json:"app,omitempty"`
	Challenge string `json:"challenge,omitempty"`
	Redirect  string `json:"redirect"`
	Verifier  string `json:"verifier,omitempty"`
}

func (s *Server) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.GoogleAuthEnabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "google_auth_unavailable",
			"Google sign-in is not configured on this instance.")
		return
	}

	next := safeGoogleNext(r.URL.Query().Get("next"))
	app := strings.TrimSpace(r.URL.Query().Get("app"))
	challenge := strings.TrimSpace(r.URL.Query().Get("challenge"))
	if app != "" || challenge != "" {
		// An app sign-in without its challenge could not be finished safely: refuse it rather
		// than fall back to a cookie in the wrong browser.
		if !appAuthApps[app] || !validChallenge(challenge) {
			httpx.Error(w, http.StatusBadRequest, "bad_request", "That app sign-in link is not valid. Start again from the app.")
			return
		}
	}
	nonce, err := randomNonce()
	if err != nil {
		s.fail(w, r, "google start: nonce", err)
		return
	}
	pkce, err := auth.NewGooglePKCE()
	if err != nil {
		s.fail(w, r, "google start: pkce", err)
		return
	}
	redirect := s.googleRedirectURI(r)
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, googleOAuthState{
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
			Issuer:    "webcast-google",
		},
		Next:      next,
		Nonce:     nonce,
		App:       app,
		Challenge: challenge,
		Redirect:  redirect,
		Verifier:  pkce.Verifier,
	})
	signed, err := tok.SignedString([]byte(s.cfg.SessionSecret))
	if err != nil {
		s.fail(w, r, "google start: sign state", err)
		return
	}

	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite set; Secure follows COOKIE_SECURE, on outside development
		Name:     googleStateCookie,
		Value:    signed,
		Path:     "/",
		Expires:  now.Add(10 * time.Minute),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: s.googleSameSite(),
	})

	hint := auth.GoogleLoginHint(r.URL.Query().Get("login_hint"))
	if hint == "" {
		hint = auth.GoogleLoginHint(r.URL.Query().Get("email"))
	}
	http.Redirect(w, r, auth.GoogleAuthCodeURL(s.cfg.GoogleClientID, redirect, signed, nonce, hint, pkce.Challenge), http.StatusFound) // #nosec G710 -- redirect to Google's fixed authorize endpoint
}

func (s *Server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	next := "/"
	app := ""

	/* The signed state in the query is what Google round-tripped. A leftover
	 * webcast_google cookie from an earlier attempt must not veto it: that is
	 * how the desktop app landed on /login?google=state after a real Google
	 * consent. The JWT signature is the CSRF check; the cookie is only a
	 * fallback when Google omitted state. */
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		if ck, err := r.Cookie(googleStateCookie); err == nil {
			state = strings.TrimSpace(ck.Value)
		}
	}
	if st, err := s.parseGoogleState(state); err == nil {
		next = safeGoogleNext(st.Next)
		if appAuthApps[st.App] && validChallenge(st.Challenge) {
			app = st.App
		}
	}

	fail := func(detail string) {
		if detail != "denied" {
			s.log.Warn("google oauth callback failed", "detail", detail,
				"google_error", r.URL.Query().Get("error"))
		}
		s.clearGoogleStateCookie(w)
		if app != "" {
			// Back to the app with the reason, so its own login page can say it.
			http.Redirect(w, r, s.appReturnURL(r, app, url.Values{"error": {detail}}), http.StatusFound) // #nosec G710 -- googleOrigin is an allowlisted origin
			return
		}
		dest := s.googleFront(r, "/login", next, detail)
		http.Redirect(w, r, dest, http.StatusFound) // #nosec G710 -- googleFront prefixes an allowlisted origin; next passed safeGoogleNext
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if gerr := r.URL.Query().Get("error"); gerr != "" && code == "" {
		if gerr == "access_denied" {
			fail("denied")
			return
		}
		fail("google")
		return
	}

	st, err := s.parseGoogleState(state)
	if err != nil {
		fail("state")
		return
	}
	next = safeGoogleNext(st.Next)
	if appAuthApps[st.App] && validChallenge(st.Challenge) {
		app = st.App
	}

	if !s.cfg.GoogleAuthEnabled() {
		fail("unset")
		return
	}

	redirect := strings.TrimSpace(st.Redirect)
	if redirect == "" {
		redirect = s.googleRedirectURI(r)
	}
	if reqRedirect := s.googleRedirectURI(r); reqRedirect != redirect {
		s.log.Info("google oauth redirect pinned", "start", redirect, "request", reqRedirect)
	}

	tok, err := auth.ExchangeGoogleCode(r.Context(), s.cfg.GoogleClientID, s.cfg.GoogleClientSecret,
		redirect, code, st.Verifier)
	if err != nil {
		s.log.Warn("google oauth exchange", "error", err, "redirect", redirect)
		fail("exchange")
		return
	}

	identity, err := auth.VerifyGoogleIDToken(tok.IDToken, s.cfg.GoogleClientID, st.Nonce)
	if err != nil {
		s.log.Warn("google oauth id token", "error", err)
		fail("token")
		return
	}

	user, created, err := s.provisionGoogleUser(r.Context(), identity, "google auth", kindForGoogle(next, false))
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

	if app != "" {
		/* Started in an app: this is the system browser, which must not be signed in. The
		 * app redeems the code from its own webview (handleAppAuthExchange). */
		code, err := s.store.IssueAppAuthCode(r.Context(), user.ID, st.Challenge, app, next)
		if err != nil {
			s.fail(w, r, "google oauth: app code", err)
			return
		}
		s.clearGoogleStateCookie(w)
		if created {
			s.queueWelcome(r.Context(), user)
			s.flushMailSoon()
		}
		s.log.Info("google auth: app hand-off", "user", user.ID, "app", app, "created", created)
		http.Redirect(w, r, s.appReturnURL(r, app, url.Values{"code": {code}}), http.StatusFound) // #nosec G710 -- googleOrigin is an allowlisted origin
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
	http.Redirect(w, r, s.googleFront(r, landingAfterSignIn(user.CanHost, next), "", ""), http.StatusFound) // #nosec G710 -- googleFront prefixes an allowlisted origin; next passed safeGoogleNext
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

	user, created, err := s.provisionGoogleUser(r.Context(), identity, "google auth",
		kindForGoogle("", strings.TrimSpace(req.From) == "webinar"))
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
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite set; Secure follows COOKIE_SECURE, on outside development
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

// canonicalGoogleOrigin maps the www alias of WEB_BASE_URL onto that apex (or
// the reverse) so authorize and token exchange use one registered redirect_uri.
// Cloudflare 301s www HTML to the apex; a start on www and a callback that
// sees the apex (or a dropped X-Forwarded-Host falling back to WebBaseURL)
// must not send Google two different redirect_uris — that is invalid_grant /
// "Bad Request" on the token endpoint.
func canonicalGoogleOrigin(origin, webBase string) string {
	base := strings.TrimRight(strings.TrimSpace(webBase), "/")
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if base == "" || origin == "" {
		return origin
	}
	u, err := url.Parse(origin)
	b, err2 := url.Parse(base)
	if err != nil || err2 != nil {
		return origin
	}
	host := strings.ToLower(u.Hostname())
	baseHost := strings.ToLower(b.Hostname())
	if host == "" || baseHost == "" {
		return origin
	}
	if host == "www."+baseHost || baseHost == "www."+host {
		return base
	}
	return origin
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
		return canonicalGoogleOrigin(origin, s.cfg.WebBaseURL)
	}
	if s.cfg.IsDev() && host != "" {
		return canonicalGoogleOrigin(origin, s.cfg.WebBaseURL)
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

/* kindForGoogle is the account kind a Google sign-in stands for. From a webinar's
 * page (the registration form's Google path, or One Tap there) it is audience;
 * from anywhere else in the app it is a customer. */
func kindForGoogle(next string, fromWebinar bool) types.AccountKind {
	if fromWebinar || strings.HasPrefix(next, "/webinars/") || strings.HasPrefix(next, "/w/") {
		return types.AccountAudience
	}
	return types.AccountCustomer
}

func (s *Server) provisionGoogleUser(ctx context.Context, identity auth.GoogleIdentity, logName string, kind types.AccountKind) (store.User, bool, error) {
	user, err := s.store.UserByEmail(ctx, identity.Email)
	created := false
	switch {
	case err == nil:
		// Back in the app itself: an audience account becomes a customer.
		if kind == types.AccountCustomer && user.AccountKind == types.AccountAudience {
			if err := s.store.PromoteToCustomer(ctx, user.ID); err != nil {
				s.log.Warn(logName+": promote to customer", "error", err, "user", user.ID)
			} else {
				user.AccountKind = types.AccountCustomer
			}
		}
	case errors.Is(err, store.ErrNotFound):
		if !s.cfg.SignupOpen {
			return store.User{}, false, errOAuthSignupClosed
		}
		user, err = s.store.CreateUser(ctx, identity.Email, "",
			identity.Name, "", "", "", false)
		if errors.Is(err, store.ErrConflict) {
			user, err = s.store.UserByEmail(ctx, identity.Email)
		} else if err == nil && kind == types.AccountAudience {
			if err = s.store.MarkAudience(ctx, user.ID); err == nil {
				user.AccountKind = types.AccountAudience
			}
		}
		if err != nil {
			return store.User{}, false, err
		}
		created = true
	default:
		return store.User{}, false, err
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
