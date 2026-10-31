package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

/* A Google callback the browser sends twice (31 Oct 2026).
 *
 * Desktop 0.1.5, 17:04 UTC: Chrome sent /api/auth/google/start twice ~95 ms apart (two request
 * ids, the same challenge, so one URL opened twice, not two sign-ins and not a logging
 * artefact) and then the callback twice ~250 ms apart, same state, same code. The first handed
 * off; the second got invalid_grant from Google, and since the second is the navigation Chrome
 * showed, its /auth/app-return?error=exchange is what the app received (it did load
 * /auth/complete?error=exchange). Whatever in the browser repeats a navigation (an extension,
 * link capturing, a prefetch, a restarted load), the callback is made idempotent rather than
 * one sender fixed.
 *
 * The first callback with a given (state, code) claims a google_callback_replays row
 * (migrations/0178) before it talks to Google, and records how it ended. A repeat within two
 * minutes is answered from the row without calling Google:
 *
 *   app flow  the same /auth/app-return link with the same one-time code. The code is derived
 *             from the row's nonce under SESSION_SECRET, so it is never stored; app_auth_codes
 *             still lets it be redeemed once, and only with the app's verifier.
 *   web flow  the same landing. The session cookie is set again only if the repeat carries the
 *             state cookie for this very state, i.e. it is the browser that started the
 *             sign-in and the first response never reached its cookie jar. Anything else is
 *             only redirected: where the first response landed, it already set the cookie.
 *   failure   the same failure ("signup", "unverified", ...), not a misleading "exchange".
 *
 * A repeat that arrives while the first is still exchanging waits for it (googleReplayWait).
 */

const (
	// googleReplayWait bounds how long a repeat waits on a first callback still at Google:
	// GoogleHTTP's own timeout plus the ID-token check, with room.
	googleReplayWait = 12 * time.Second
	googleReplayPoll = 50 * time.Millisecond
)

var errGoogleCallbackBusy = errors.New("google callback still in progress")

// googleCallbackKey identifies one Google redirect: the signed state and the code it carried.
func googleCallbackKey(state, code string) string {
	sum := sha256.Sum256([]byte(state + "\x00" + code))
	return hex.EncodeToString(sum[:])
}

/* googleAppCode is the app hand-off code for a replay row: 64 hex characters, like
 * auth.RandomToken(32), and the same for the first callback and every repeat of it. */
func (s *Server) googleAppCode(nonce string) string {
	m := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	m.Write([]byte("webinarliv google app code v1\x00" + nonce))
	return hex.EncodeToString(m.Sum(nil))
}

/* claimGoogleCallback claims key for this request, or waits for the request that holds it.
 * claimed means go on to Google; otherwise c is the first request's finished outcome. */
func (s *Server) claimGoogleCallback(ctx context.Context, key string) (c store.GoogleCallback, claimed bool, err error) {
	deadline := time.Now().Add(googleReplayWait)
	for {
		c, claimed, err = s.store.ClaimGoogleCallback(ctx, key)
		if err != nil || claimed || c.Done {
			return c, claimed, err
		}
		if time.Now().After(deadline) {
			return c, false, errGoogleCallbackBusy
		}
		select {
		case <-ctx.Done():
			return c, false, ctx.Err()
		case <-time.After(googleReplayPoll):
		}
	}
}

/* answerGoogleReplay answers a repeated callback from the first one's outcome. fail is the
 * callback's own failure path. */
func (s *Server) answerGoogleReplay(w http.ResponseWriter, r *http.Request, state string, c store.GoogleCallback, fail func(string)) {
	s.log.Info("google oauth callback replayed", "app", c.App, "failed", c.Failure != "")
	if c.Failure != "" {
		fail(c.Failure)
		return
	}
	s.clearGoogleStateCookie(w)
	if c.App != "" {
		http.Redirect(w, r, s.appReturnURL(r, c.App, url.Values{"code": {s.googleAppCode(c.Nonce)}}), http.StatusFound) // #nosec G710 -- googleOrigin is an allowlisted origin
		return
	}
	if ck, err := r.Cookie(googleStateCookie); err == nil && c.UserID != "" &&
		subtle.ConstantTimeCompare([]byte(ck.Value), []byte(state)) == 1 {
		session, exp, err := s.sessions.Issue(c.UserID)
		if err != nil {
			s.fail(w, r, "google oauth replay: issue session", err)
			return
		}
		s.sessions.SetCookie(w, session, exp)
		s.store.TouchLogin(r.Context(), c.UserID)
	}
	http.Redirect(w, r, s.googleFront(r, c.Landing, "", ""), http.StatusFound) // #nosec G710 -- googleFront prefixes an allowlisted origin; Landing passed safeGoogleNext
}
