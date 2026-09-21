package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/auth"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

type ctxKey string

const (
	userCtxKey ctxKey = "user"
	slugCtxKey ctxKey = "slug"
	// roleCtxKey carries how the caller is entitled to this webinar's stage —
	// host or panelist. Set by requireStage.
	roleCtxKey ctxKey = "stageRole"
	// trueOwnerCtxKey records whether requireOwnership admitted this caller as
	// the actual account in webinars.host_id, or as a co-host let in as a
	// courtesy. Read by requireTrueOwner.
	trueOwnerCtxKey ctxKey = "trueOwner"
)

func userFromContext(ctx context.Context) store.User {
	u, _ := ctx.Value(userCtxKey).(store.User)
	return u
}

// requireUser rejects anything without a valid session cookie. It says nothing
// about what the account may do — that is requireHost's job.
func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, user)))
	})
}

// requireHost additionally requires the hosting capability.
//
// Hosting is a property of the account in the database, so an attendee account
// cannot reach a host endpoint by guessing the URL, and a client cannot ask to
// be a host — there is no field in any request that says so.
func (s *Server) requireHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		// An admin without hosting capability still reads through, on a GET — the
		// outer half of the same read-only carve-out requireOwnership makes further
		// in. Without this, an admin who has never been granted CanHost could never
		// reach requireOwnership's admin branch at all: this gate runs first.
		admin := user.IsAdmin && r.Method == http.MethodGet
		if !user.CanHost && !admin {
			// The old copy said "turn hosting on in your account settings", which is now a
			// lie: the toggle is gone and only an admin can grant it. Copy that tells
			// somebody to do an impossible thing is worse than a bare refusal.
			httpx.Error(w, http.StatusForbidden, "not_a_host",
				"This account can't host webinars. An administrator has to grant hosting access.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, user)))
	})
}

// authenticate resolves the session cookie to a user, writing the error
// response itself and reporting whether the caller should continue.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		// AUTH_BYPASS: no cookie is not a refusal, it is a new person. Give them an
		// account and a session and carry on as if they had signed in.
		if s.cfg.AuthBypass {
			return s.bypassUser(w, r)
		}
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in.")
		return store.User{}, false
	}
	userID, err := s.sessions.Verify(cookie.Value)
	if err != nil {
		s.sessions.ClearCookie(w) // stale or forged — get rid of it
		// A leftover cookie from a previous deployment would otherwise lock somebody
		// out of a site that has no sign-in page to recover through.
		if s.cfg.AuthBypass {
			return s.bypassUser(w, r)
		}
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in again.")
		return store.User{}, false
	}
	user, err := s.store.UserByID(r.Context(), userID)
	if err != nil {
		// Valid signature but the user is gone.
		s.sessions.ClearCookie(w)
		if s.cfg.AuthBypass {
			return s.bypassUser(w, r)
		}
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Please sign in again.")
		return store.User{}, false
	}
	return user, true
}

// sessionUser is authenticate without writing a response — for the YouTube
// OAuth callback, which is a browser redirect and must answer with another
// redirect rather than a JSON 401.
func (s *Server) sessionUser(r *http.Request) (store.User, error) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return store.User{}, err
	}
	userID, err := s.sessions.Verify(cookie.Value)
	if err != nil {
		return store.User{}, err
	}
	return s.store.UserByID(r.Context(), userID)
}

// bypassUser provisions an account for a caller who has none, and signs them in.
// Only ever reached when AUTH_BYPASS is on.
//
// A real account rather than a synthetic one, because everything downstream —
// stage grants, the host roster, recordings, LiveKit identities — is keyed on a
// user row, and inventing a user that does not exist would mean special-casing all
// of it.
//
// Host-capable, because "bypass the auth" is the point: whoever opens the URL can
// schedule, start and moderate. Distinct per browser rather than one shared login,
// because two participants sharing a LiveKit identity disconnect each other — a
// single account would mean each laptop kicking the last one out of the room.
func (s *Server) bypassUser(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	suffix, err := auth.RandomToken(6)
	if err != nil {
		s.fail(w, r, "auth bypass: random", err)
		return store.User{}, false
	}
	// A password nobody holds. The account is reachable only through the cookie
	// issued below, so there is nothing to guess even with signup open.
	secret, err := auth.RandomToken(32)
	if err != nil {
		s.fail(w, r, "auth bypass: random", err)
		return store.User{}, false
	}
	hash, err := auth.HashPassword(secret)
	if err != nil {
		s.fail(w, r, "auth bypass: hash", err)
		return store.User{}, false
	}

	// Short enough to read in a participant list. The full suffix stays on the email,
	// which is what has to be unique.
	name := "Guest " + strings.ToUpper(suffix[:4])
	user, err := s.store.CreateUser(r.Context(),
		fmt.Sprintf("guest-%s@bypass.invalid", strings.ToLower(suffix)),
		hash, name, "", "", "", true)
	if err != nil {
		s.fail(w, r, "auth bypass: create user", err)
		return store.User{}, false
	}

	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "auth bypass: issue session", err)
		return store.User{}, false
	}
	s.sessions.SetCookie(w, token, exp)

	s.log.Info("auth bypass: provisioned a guest host", "user", user.ID, "name", name)
	return user, true
}

// optionalUser resolves a session if one is present and valid, and otherwise
// reports no user without writing anything.
//
// Used on the public register and join paths: those work for someone with no
// account at all, but should link to the account when there is one.
func (s *Server) optionalUser(r *http.Request) (store.User, bool) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return store.User{}, false
	}
	userID, err := s.sessions.Verify(cookie.Value)
	if err != nil {
		return store.User{}, false
	}
	user, err := s.store.UserByID(r.Context(), userID)
	if err != nil {
		return store.User{}, false
	}
	return user, true
}

/* requireAdmin gates the one capability that grants other capabilities.
 *
 * 403 rather than 404 here, unlike requireOwnership. Hiding the existence of an admin area
 * from a signed-in user buys nothing — the routes are in the public bundle either way — and a
 * bare 404 on /api/admin would send whoever is actually an admin hunting for a bug in their
 * own deployment.
 */
func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		if !user.IsAdmin {
			httpx.Error(w, http.StatusForbidden, "not_an_admin",
				"This account isn't an administrator.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, user)))
	})
}

/* requireOwnership resolves {slug} and confirms the caller hosts it, so every
 * per-webinar host route is authorized in one place rather than each handler
 * remembering to check.
 *
 * A co-host passes this too — see store.SetCoHost — because a co-host is meant
 * to control anything the host can, in-session. The two things that stay
 * host-only regardless (deleting the webinar, transferring it away) are not
 * enforced here: they sit behind the extra requireTrueOwner, which reads the
 * flag this middleware leaves in the context.
 *
 * An admin passes too, but only for a GET — read access to any webinar's
 * details, chat archive, polls, registrants, so an admin can actually look
 * into a report without the host's help. Deliberately not every verb: this
 * subtree is also where mute-all, end-webinar and remove-participant live,
 * and "admin can see everything" was never "admin can run someone else's
 * live session." Method-gated here rather than split into a separate route
 * group, so nothing has to be told twice which endpoints are reads.
 */
func (s *Server) requireOwnership(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slug := chi.URLParam(r, "slug")
		user := userFromContext(r.Context())

		hostID, err := s.store.HostIDFor(r.Context(), slug)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return
		}
		if err != nil {
			s.fail(w, r, "ownership check", err)
			return
		}
		trueOwner := hostID == user.ID
		if !trueOwner {
			grant, err := s.store.StageGrant(r.Context(), slug, hostIdentity(user.ID))
			if err != nil {
				s.fail(w, r, "co-host check", err)
				return
			}
			if !grant.CoHost && !(user.IsAdmin && r.Method == http.MethodGet) {
				// 404 rather than 403: don't confirm the webinar exists to
				// someone who has no business knowing.
				httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
				return
			}
		}
		ctx := context.WithValue(r.Context(), slugCtxKey, slug)
		ctx = context.WithValue(ctx, trueOwnerCtxKey, trueOwner)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

/* requireTrueOwner narrows the door back down to the account actually listed in
 * webinars.host_id, for the handful of actions a co-host may not take: deleting
 * the webinar, and transferring it away. Both would otherwise let someone the
 * host merely made equal to themselves either destroy the webinar outright or
 * hand it to a third party — neither of which "control anything the host can,
 * for this session" was meant to include.
 *
 * Must run after requireOwnership, which is what puts trueOwnerCtxKey in the
 * context; on its own this refuses everyone.
 */
func (s *Server) requireTrueOwner(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trueOwner, _ := r.Context().Value(trueOwnerCtxKey).(bool)
		if !trueOwner {
			httpx.Error(w, http.StatusForbidden, "host_only",
				"Only the webinar's host can do that.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func slugFromContext(ctx context.Context) string {
	slug, _ := ctx.Value(slugCtxKey).(string)
	return slug
}

// requireStage resolves {slug} and confirms the caller is on its stage — the host
// or one of its panelists.
//
// A wider door than requireOwnership and a much narrower one than requireUser.
// Recording lives here: a panelist presenting a section should be able to record
// it, and the audience must not be able to record anything at all. The role it
// resolves is put in the context, because "did the host do this or a panelist"
// changes what some of those handlers allow.
//
// An admin reads in on a GET the same way requireOwnership lets them read the
// webinar itself — listing and downloading recordings, never starting, chunking,
// completing or deleting one (all POST/DELETE, so never reach this branch).
// Reported as RoleHost: the one place downstream that reads the role at all,
// handleDeleteRecording, is a DELETE and therefore never sees an admin's request
// in the first place.
func (s *Server) requireStage(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.authenticate(w, r)
		if !ok {
			return
		}
		slug := chi.URLParam(r, "slug")

		role, err := s.stageRole(r.Context(), slug, user.ID)
		if errors.Is(err, store.ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
			return
		}
		if err != nil {
			s.fail(w, r, "stage check", err)
			return
		}
		if role == "" && user.IsAdmin && r.Method == http.MethodGet {
			role = types.RoleHost
		}
		if role == "" {
			httpx.Error(w, http.StatusForbidden, "forbidden",
				"You're not the host or a panelist on this webinar.")
			return
		}

		ctx := context.WithValue(r.Context(), userCtxKey, user)
		ctx = context.WithValue(ctx, slugCtxKey, slug)
		ctx = context.WithValue(ctx, roleCtxKey, role)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// stageRole reports how this account is entitled to be on a webinar's stage, or
// "" for anyone else. One place, so the join path and the recording endpoints
// cannot come to different conclusions about who is a panelist.
func (s *Server) stageRole(ctx context.Context, slug, userID string) (types.Role, error) {
	hostID, err := s.store.HostIDFor(ctx, slug)
	if err != nil {
		return "", err
	}
	if hostID == userID {
		return types.RoleHost, nil
	}
	panelists, err := s.store.PanelistIDs(ctx, slug)
	if err != nil {
		return "", err
	}
	for _, id := range panelists {
		if id == userID {
			return types.RolePanelist, nil
		}
	}
	return "", nil
}

func stageRoleFromContext(ctx context.Context) types.Role {
	role, _ := ctx.Value(roleCtxKey).(types.Role)
	return role
}

// ------------------------------------------------------------------- signup

func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.SignupOpen {
		httpx.Error(w, http.StatusForbidden, "signup_closed",
			"New accounts are closed on this instance.")
		return
	}

	var req types.SignupRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	if fields := validateSignup(req); len(fields) > 0 {
		httpx.Fields(w, fields)
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		s.fail(w, r, "signup: hash password", err)
		return
	}

	/* Always created WITH the hosting capability now — every new account can host from
	 * the moment it exists, whatever req.WantsHost says (see its own doc comment: kept
	 * on the wire but no longer meaningful either way, since the answer is always yes).
	 * An admin can still take it away afterward with SetHostCapability; that stays the
	 * only way hosting is ever revoked. */
	user, err := s.store.CreateUser(r.Context(), req.Email, hash,
		req.Name, req.Title, req.Org, req.Phone, true)
	if errors.Is(err, store.ErrConflict) {
		// Naming the conflict is the right call here. The address is already
		// discoverable by trying to sign in, and hiding it only produces
		// people who cannot work out why signup silently failed.
		httpx.Fields(w, map[string]string{
			"email": "An account already uses this address. Sign in instead.",
		})
		return
	}
	if err != nil {
		s.fail(w, r, "signup", err)
		return
	}

	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "signup: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)
	// can_host is logged mainly as a sanity check — it should always read true for a
	// fresh signup now — and requested_host is kept for the historical record even
	// though it no longer changes the outcome either way.
	s.log.Info("signup", "user", user.ID, "can_host", user.CanHost,
		"requested_host", req.WantsHost, "email_domain", domainOf(user.Email))
	httpx.JSON(w, http.StatusCreated, user.Public())
}

/* validateSignup. Password has no length floor here on purpose — the
 * server-wide MinPasswordLength setting now governs only the bootstrap
 * AdminPassword (config.go), not this form. A real product with coaches and
 * students signing up should ask for one; this instance doesn't yet, and
 * asking is a one-line change (add minPassword back as a parameter and a
 * case in the switch below) rather than a redesign when it's wanted.
 */
func validateSignup(req types.SignupRequest) map[string]string {
	fields := map[string]string{}

	if strings.TrimSpace(req.Name) == "" {
		fields["name"] = "Required."
	} else if utf8.RuneCountInString(req.Name) > 120 {
		fields["name"] = "That name is too long."
	}

	email := strings.TrimSpace(req.Email)
	switch {
	case email == "":
		fields["email"] = "Required."
	case len(email) > 320:
		fields["email"] = "That address is too long."
	default:
		if _, err := mail.ParseAddress(email); err != nil {
			fields["email"] = "That doesn't look like an email address."
		}
	}

	switch {
	case req.Password == "":
		fields["password"] = "Required."
	case len(req.Password) > 1024:
		// Not a strength rule — argon2id will happily hash a megabyte and burn
		// a core doing it. This bound stays regardless of the length floor.
		fields["password"] = "That password is too long."
	}

	if msg := phoneFieldError(req.Phone); msg != "" {
		fields["phone"] = msg
	}

	return fields
}

/* phoneFieldError shape-checks an OPTIONAL mobile number — empty is fine,
 * present-and-malformed is not. Shared with handleRegister's identical
 * check (webinars.go), which this was extracted from verbatim rather than
 * reimplemented, so the two forms can never quietly disagree about what a
 * valid number looks like.
 *
 * Validated on shape rather than by a phone-number library, and that is a
 * deliberate limit: knowing that +91 98765 43210 is a real Indian mobile and
 * +91 12345 67890 is not needs a per-country numbering plan that goes stale,
 * and getting it wrong turns away a real person. E.164 bounds are the part
 * that is stable — a country code is 1 to 3 digits and the whole number is
 * at most 15 — so that is what is checked.
 */
func phoneFieldError(phone string) string {
	if strings.TrimSpace(phone) == "" {
		return ""
	}
	digits := 0
	for _, r := range phone {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	switch {
	case digits < 8:
		return "That number looks too short — include the country code."
	case digits > 15:
		return "That number is too long."
	}
	return ""
}

// -------------------------------------------------------------------- login

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req types.LoginRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	user, err := s.store.UserByEmail(r.Context(), req.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "login: lookup", err)
		return
	}

	// Always run a verification, even when the user doesn't exist, so response
	// time doesn't reveal which emails are registered. The dummy hash below is
	// argon2id of a random string.
	stored := user.PasswordHash
	if stored == "" {
		stored = dummyHash
	}
	verifyErr := auth.VerifyPassword(req.Password, stored)

	if errors.Is(err, store.ErrNotFound) || verifyErr != nil {
		s.log.Warn("failed login", "email_domain", domainOf(strings.ToLower(req.Email)),
			"ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusUnauthorized, "invalid_credentials",
			"That email and password don't match.")
		return
	}

	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "login: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)
	s.store.TouchLogin(r.Context(), user.ID)
	s.log.Info("login", "user", user.ID)
	httpx.JSON(w, http.StatusOK, user.Public())
}

// dummyHash makes the no-such-user path cost the same as a real verification.
const dummyHash = "$argon2id$v=19$m=65536,t=1,p=4$YWJjZGVmZ2hpamtsbW5vcA$" +
	"J6mA1cQ0dLZ5xU8kZfKQ7nOD3VJZ0mR2sT4uW6yX8aE"

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.ClearCookie(w)
	httpx.JSON(w, http.StatusOK, types.StatusResponse{Status: "signed out"})
}

/* handleSupabaseAuth is POST /api/auth/supabase.
 *
 * Verifies a Supabase Auth access token (Google OAuth via Supabase JS), then
 * creates or links a local users row and sets webcast_session — the same cookie
 * password login uses. Password accounts keep working; this is an alternate door.
 */
func (s *Server) handleSupabaseAuth(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.GoogleAuthEnabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "google_auth_unavailable",
			"Google sign-in is not configured on this instance.")
		return
	}

	var req types.SupabaseAuthRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}

	identity, err := auth.VerifySupabaseAccessToken(
		req.AccessToken, s.cfg.SupabaseJWTSecret, s.cfg.SupabaseURL)
	if err != nil {
		s.log.Warn("supabase auth rejected", "error", err, "ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusUnauthorized, "invalid_token",
			"That Google sign-in could not be verified. Try again.")
		return
	}

	user, err := s.store.UserByEmail(r.Context(), identity.Email)
	created := false
	switch {
	case err == nil:
		// Existing password or prior OAuth account — link by email and sign in.
	case errors.Is(err, store.ErrNotFound):
		if !s.cfg.SignupOpen {
			httpx.Error(w, http.StatusForbidden, "signup_closed",
				"New accounts are closed on this instance.")
			return
		}
		// Same policy as handleSignup: every new account can host from the
		// moment it exists, whichever door they signed up through. No phone
		// either way — Google sign-in doesn't collect one.
		user, err = s.store.CreateUser(r.Context(), identity.Email, "",
			identity.Name, "", "", "", true)
		if errors.Is(err, store.ErrConflict) {
			// Race with a parallel signup: look up again.
			user, err = s.store.UserByEmail(r.Context(), identity.Email)
		}
		if err != nil {
			s.fail(w, r, "supabase auth: create user", err)
			return
		}
		created = true
	default:
		s.fail(w, r, "supabase auth: lookup", err)
		return
	}

	token, exp, err := s.sessions.Issue(user.ID)
	if err != nil {
		s.fail(w, r, "supabase auth: issue session", err)
		return
	}
	s.sessions.SetCookie(w, token, exp)
	s.store.TouchLogin(r.Context(), user.ID)
	s.log.Info("supabase auth", "user", user.ID, "created", created,
		"email_domain", domainOf(user.Email))
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	httpx.JSON(w, status, user.Public())
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, userFromContext(r.Context()).Public())
}

func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	var p types.ProfilePatch
	if err := httpx.DecodeJSON(w, r, &p); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if p.Name != nil && strings.TrimSpace(*p.Name) == "" {
		httpx.Fields(w, map[string]string{"name": "Required."})
		return
	}

	user := userFromContext(r.Context())
	updated, err := s.store.UpdateProfile(r.Context(), user.ID, p)
	if err != nil {
		s.fail(w, r, "update profile", err)
		return
	}
	httpx.JSON(w, http.StatusOK, updated.Public())
}

func (s *Server) handleMyRegistrations(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	rows, err := s.store.ByUser(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "my registrations", err)
		return
	}
	// An attendee's own list, so the embedded webinar is redacted the same way the
	// public endpoints are — this is somebody who registered, not the host.
	for i := range rows {
		rows[i].Webinar = publicWebinar(rows[i].Webinar)
	}
	httpx.JSON(w, http.StatusOK, rows)
}
