package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Google sign-in for the desktop and mobile apps (29 Oct 2026).
 *
 * Google refuses OAuth in embedded webviews (disallowed_useragent), and the desktop app used to
 * get round that by dressing Electron up as plain Chrome. Instead, when Continue with Google
 * starts inside an app, the page opens /api/auth/google/start in the SYSTEM browser (Electron's
 * shell.openExternal; SFSafariViewController / Custom Tabs on the phones) with
 *
 *	?app=desktop|ios|android&challenge=<base64url SHA-256 of a random verifier>
 *
 * and keeps the verifier in the app's own storage. Both ride in the signed OAuth state. The
 * callback, in that system browser, sets no session cookie there. It stores a hand-off code
 * (store.IssueAppAuthCode: 32 random bytes, only the hash kept, two minutes, one try) and sends
 * the browser to /auth/app-return#code=…, a page that opens webinarliv://auth/complete?code=….
 * The app catches the link, loads /auth/complete?code=… in its webview, and that page POSTs the
 * code with the verifier to /api/auth/app/exchange, which sets the normal session cookie in
 * the webview and says where to go.
 *
 * What that buys:
 *   - The session token is never in a URL. The code is, but alone it is worthless: redeeming it
 *     takes the verifier, which never left the app (the PKCE idea, RFC 7636 S256). A code read
 *     off the browser history, or caught by another app registered for webinarliv://, fails.
 *   - A code is spent by its first redemption attempt, right verifier or wrong, so there is
 *     no second guess; it also dies after two minutes, and exchange is rate-limited per IP.
 *   - The code is in the return page's fragment, so it is not in any server's access log or a
 *     Referer.
 *
 * Email and password, and the email links, are untouched: they already run inside the app. */

// appAuthApps are the values ?app= may take. Anything else is an ordinary web sign-in.
var appAuthApps = map[string]bool{"desktop": true, "ios": true, "android": true}

// validChallenge is a base64url (unpadded) SHA-256: 43 characters of the URL-safe alphabet.
func validChallenge(c string) bool {
	if len(c) != 43 {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(c)
	return err == nil
}

/* validVerifier is RFC 7636's code_verifier: 43 to 128 unreserved characters. The app makes
 * 32 random bytes, base64url, which is 43. */
func validVerifier(v string) bool {
	if len(v) < 43 || len(v) > 128 {
		return false
	}
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '.', r == '_', r == '~':
		default:
			return false
		}
	}
	return true
}

// ChallengeFor is S256: base64url(SHA-256(verifier)), unpadded.
func ChallengeFor(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

/* appReturnURL is the page in the system browser that hands the result back to the app:
 * /auth/app-return#code=… on success, #error=… when the sign-in failed. The fragment keeps
 * both out of server logs. */
func (s *Server) appReturnURL(r *http.Request, app string, v url.Values) string {
	v.Set("app", app)
	return s.googleOrigin(r) + "/auth/app-return#" + v.Encode()
}

/* handleAppAuthExchange is POST /api/auth/app/exchange: the app's webview trades the hand-off
 * code and its verifier for the session cookie. Every failure is a 400 the page can explain;
 * none says more than "start again". */
func (s *Server) handleAppAuthExchange(w http.ResponseWriter, r *http.Request) {
	var req types.AppAuthExchangeRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" || len(code) > 128 || !validVerifier(req.Verifier) {
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That sign-in link is not valid. Start again from the app.")
		return
	}
	c, err := s.store.RedeemAppAuthCode(r.Context(), code)
	switch {
	case errors.Is(err, store.ErrAppCodeExpired):
		httpx.Error(w, http.StatusBadRequest, "code_expired", "That sign-in took too long. Start again from the app.")
		return
	case errors.Is(err, store.ErrAppCodeUsed):
		s.log.Warn("app auth: code reused", "ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusBadRequest, "code_used", "That sign-in link was already used. Start again from the app.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That sign-in link is not valid. Start again from the app.")
		return
	case err != nil:
		s.fail(w, r, "app auth: redeem", err)
		return
	}
	if subtle.ConstantTimeCompare([]byte(ChallengeFor(req.Verifier)), []byte(c.Challenge)) != 1 {
		// The code is spent already (RedeemAppAuthCode), so this was the only guess.
		s.log.Warn("app auth: wrong verifier", "user", c.UserID, "app", c.App, "ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That sign-in link is not valid. Start again from the app.")
		return
	}
	user, err := s.store.UserByID(r.Context(), c.UserID)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That account no longer exists.")
		return
	}
	if err != nil {
		s.fail(w, r, "app auth: user", err)
		return
	}
	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "app auth: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)
	s.store.TouchLogin(r.Context(), user.ID)
	s.log.Info("app auth", "user", user.ID, "app", c.App)
	httpx.JSON(w, http.StatusOK, types.AppAuthExchangeResponse{
		Account: user.Public(),
		Next:    landingAfterSignIn(user.CanHost, safeGoogleNext(c.Next)),
	})
}
