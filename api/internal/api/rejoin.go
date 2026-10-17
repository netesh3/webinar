package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Getting back into the room after a refresh, or after reopening the link.
 *
 * Two halves. The browser remembers WHEN it was last in the room and how its mic and camera
 * were (lib/rejoin.ts) — that decides whether to try at all. The server decides whether the
 * person may: the same gates as a first join, plus "the host has not removed you".
 *
 * The credential for a guest is the rejoin cookie set here on every successful attendee join.
 * A join key already sits in localStorage for most people, so the cookie is the fallback for a
 * browser that lost it (a guest who came in on ?k= and whose storage was cleared, a private
 * window that kept cookies for the session). It is httpOnly, so no script can read it, and it
 * holds a signed reference to the registration — never the join key itself.
 */

const (
	rejoinCookieName = "webcast_rejoin"
	// A different issuer from the session cookie's "webcast", so a rejoin token signed with
	// the same secret can never be presented as a session, nor a session as a rejoin token.
	rejoinIssuer = "webcast-rejoin"
	// How long after the scheduled end a rejoin token still works. Sessions overrun.
	rejoinTail = 4 * time.Hour
)

var errRejoinInvalid = errors.New("invalid rejoin token")

type rejoinClaims struct {
	jwt.RegisteredClaims
}

// signRejoin returns a token naming one registration, good for one webinar until exp.
func signRejoin(secret []byte, regID, slug string, now, exp time.Time) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, rejoinClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   regID,
			Audience:  jwt.ClaimStrings{slug},
			Issuer:    rejoinIssuer,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	})
	return tok.SignedString(secret)
}

// verifyRejoin returns the registration id in token if it is genuine, unexpired and
// was issued for slug. Anything else is errRejoinInvalid.
func verifyRejoin(secret []byte, token, slug string, now time.Time) (string, error) {
	parsed, err := jwt.ParseWithClaims(token, &rejoinClaims{},
		func(t *jwt.Token) (any, error) { return secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(rejoinIssuer),
		jwt.WithAudience(slug),
		jwt.WithExpirationRequired(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	if err != nil {
		return "", errors.Join(errRejoinInvalid, err)
	}
	c, ok := parsed.Claims.(*rejoinClaims)
	if !ok || c.Subject == "" {
		return "", errRejoinInvalid
	}
	return c.Subject, nil
}

// rejoinExpiry is the scheduled end plus rejoinTail — or now plus rejoinTail when the
// session is already running past its schedule, so an overrunning webinar still gets
// a cookie that outlives the next refresh.
func rejoinExpiry(wb types.Webinar, now time.Time) time.Time {
	end := now
	if start, err := time.Parse(time.RFC3339, wb.StartsAt); err == nil {
		if sched := start.Add(time.Duration(wb.Duration) * time.Minute); sched.After(end) {
			end = sched
		}
	}
	return end.Add(rejoinTail)
}

// rejoinCookiePath scopes the cookie to this webinar's API routes: join, say, the
// rejoin check and leave all live under it, and no other webinar's do. The browser
// reaches the API same-origin through the Worker's /api proxy (web/worker.ts).
func rejoinCookiePath(slug string) string { return "/api/webinars/" + slug }

func (s *Server) setRejoinCookie(w http.ResponseWriter, wb types.Webinar, reg types.Registration) {
	if reg.ID == "" || s.cfg.SessionSecret == "" {
		return
	}
	now := time.Now()
	exp := rejoinExpiry(wb, now)
	token, err := signRejoin([]byte(s.cfg.SessionSecret), reg.ID, wb.ID, now, exp)
	if err != nil {
		s.log.Warn("rejoin: could not sign token", "slug", wb.ID, "error", err)
		return
	}
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite set; Secure follows COOKIE_SECURE, on outside development
		Name:     rejoinCookieName,
		Value:    token,
		Path:     rejoinCookiePath(wb.ID),
		Expires:  exp,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearRejoinCookie(w http.ResponseWriter, slug string) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite set; Secure follows COOKIE_SECURE, on outside development
		Name:     rejoinCookieName,
		Value:    "",
		Path:     rejoinCookiePath(slug),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

// rejoinCookieRegistration resolves the rejoin cookie to its registration. ok is false
// when there is no cookie, it does not verify for slug, or its registration is gone.
func (s *Server) rejoinCookieRegistration(r *http.Request, slug string) (types.Registration, bool, error) {
	c, err := r.Cookie(rejoinCookieName)
	if err != nil || c.Value == "" {
		return types.Registration{}, false, nil
	}
	regID, err := verifyRejoin([]byte(s.cfg.SessionSecret), c.Value, slug, time.Now())
	if err != nil {
		return types.Registration{}, false, nil
	}
	key, err := s.store.JoinKeyForRegistration(r.Context(), regID)
	if errors.Is(err, store.ErrNotFound) {
		return types.Registration{}, false, nil
	}
	if err != nil {
		return types.Registration{}, false, err
	}
	reg, err := s.store.ByJoinKey(r.Context(), key)
	if errors.Is(err, store.ErrNotFound) {
		return types.Registration{}, false, nil
	}
	if err != nil {
		return types.Registration{}, false, err
	}
	return reg, true, nil
}

// isRejoin reports whether the client marked this join as automatic — a refresh or a
// reopened link rather than somebody pressing Join. An automatic join is refused for a
// person the host removed; a deliberate one is not, which is how removal has always
// behaved.
func isRejoin(r *http.Request) bool { return r.URL.Query().Get("rejoin") == "1" }

// refuseRemoved writes 403 removed, and clears the rejoin cookie, when identity was
// removed from this run of the webinar. It returns true when it refused.
func (s *Server) refuseRemoved(w http.ResponseWriter, r *http.Request, slug, identity string) bool {
	removed, err := s.store.WasRemoved(r.Context(), slug, identity)
	if err != nil {
		// Fail closed: the cost is one person seeing the join page instead of the room.
		s.log.Warn("rejoin: removal lookup failed, refusing", "slug", slug, "error", err)
		removed = true
	}
	if !removed {
		return false
	}
	s.clearRejoinCookie(w, slug)
	httpx.Error(w, http.StatusForbidden, "removed",
		"The host removed you from this session.")
	return true
}

/* handleRejoinCheck answers "should this browser go straight back into the room?".
 *
 * Asked by the webinar page when it opens and the browser says it was in the room a few
 * minutes ago. Never an error for a no — the page simply renders as normal — so every
 * refusal is 200 with rejoin false and a reason the client can log.
 *
 * The credential is whatever the join would use: a join key in the body, the session, or
 * the rejoin cookie. A signed-in host or panelist is answered for the stage instead.
 */
func (s *Server) handleRejoinCheck(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	var req types.JoinRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	no := func(reason string) {
		httpx.JSON(w, http.StatusOK, types.RejoinCheckResponse{Reason: reason})
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		no("not_found")
		return
	}
	if err != nil {
		s.fail(w, r, "rejoin check: load webinar", err)
		return
	}
	if wb.Status == types.StatusEnded {
		s.clearRejoinCookie(w, slug)
		no("ended")
		return
	}

	// The stage first: a panelist who is also registered belongs on the stage.
	if user, signedIn := s.optionalUser(r); signedIn {
		role, err := s.stageRole(r.Context(), slug, user.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.fail(w, r, "rejoin check: stage role", err)
			return
		}
		if role != "" {
			if role == types.RolePanelist {
				if removed, _ := s.store.WasRemoved(r.Context(), slug, hostIdentity(user.ID)); removed {
					no("removed")
					return
				}
			}
			// The green room is open to the stage before the start, so anything not
			// ended is somewhere to go back to.
			httpx.JSON(w, http.StatusOK, types.RejoinCheckResponse{Rejoin: true, Stage: true})
			return
		}
	}

	// The audience only goes back into a running session. Before the start there is
	// nothing to have been in, and the landing page is the right place to wait.
	if wb.Status != types.StatusLive {
		no("not_live")
		return
	}

	reg, ok := s.resolveRegistration(discardResponse{}, r, slug, req.JoinKey)
	if !ok {
		no("no_credential")
		return
	}
	if reg.State != types.RegApproved {
		no("not_approved")
		return
	}
	if removed, err := s.store.WasRemoved(r.Context(), slug, attendeeIdentity(reg.JoinKey)); err != nil || removed {
		s.clearRejoinCookie(w, slug)
		no("removed")
		return
	}
	if b := s.audienceBarrier(wb); b != nil {
		no(b.code)
		return
	}
	httpx.JSON(w, http.StatusOK, types.RejoinCheckResponse{Rejoin: true})
}

// handleLeave is the Leave button: the person meant to go, so the browser should not
// put them back. It only clears the rejoin cookie; there is nothing to authorize.
func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	s.clearRejoinCookie(w, slug)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "left"})
}

// discardResponse swallows what resolveRegistration would have told the client, for a
// caller that only wants the yes or no.
type discardResponse struct{}

func (discardResponse) Header() http.Header         { return http.Header{} }
func (discardResponse) Write(b []byte) (int, error) { return len(b), nil }
func (discardResponse) WriteHeader(int)             {}
