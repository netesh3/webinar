package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

/* Connect Zoom, Connect YouTube and the Drive picker from the desktop and mobile apps
 * (29 Oct 2026).
 *
 * The same problem as Continue with Google (auth_app.go): the OAuth has to run in the SYSTEM
 * browser (Google refuses embedded webviews, and the phones send off-site navigation out of
 * the WebView), but the account being connected is signed in to the APP's webview, and the
 * callbacks used to find it in the session cookie. The flow, for Zoom and YouTube:
 *
 *  1. The app's webview, signed in, POSTs /api/host/integrations/{zoom|youtube}/app-ticket.
 *     It gets a ticket (32 random bytes, only the hash kept, two minutes, one use, bound to
 *     the account and the provider) inside a start URL, which it opens in the system browser.
 *  2. GET /api/integrations/{provider}/app-start?ticket=…&app=… spends the ticket and signs the
 *     usual OAuth state with the account, the app and the attempt's id in it, sets the usual
 *     state cookie in that browser, and goes to the provider.
 *  3. The callback sees an app state. It connects NOTHING there: it requires the state cookie
 *     (so the state came back to the browser that spent the ticket), parks the provider's
 *     authorization code on the attempt (sealed, two minutes, once: a replayed callback is
 *     refused) and sends the browser to /connect/app-return#code=…, which opens
 *     webinarliv://connect/complete?code=….
 *  4. The app loads /connect/complete?code=… in its webview, which POSTs the code to
 *     /api/host/integrations/app/complete. Only if that webview's session is the ticket's
 *     account does the API exchange the provider's code and store the tokens, exactly as the
 *     web callback does (zoomConnectCode, youtubeConnectCode).
 *
 * Why the provider's code waits for step 4 rather than being exchanged in step 3: a ticket
 * link is a URL, and a URL can be sent to somebody else. If the callback stored the tokens,
 * whoever clicked a stranger's link and pressed Allow would connect THEIR Zoom to the
 * stranger's account. Deferred, the completion code lands in the clicker's own app (whose
 * session is not the ticket's account: refused, and the code is spent) or nowhere, and never
 * with the sender. No session and no OAuth token is ever in a URL: the ticket and the codes
 * are one-time and worthless alone, and the provider's code needs our client secret.
 *
 * Google Drive (the room's "Pick from Drive") is not an OAuth connection: the web page asks
 * Google Identity Services for a short drive.readonly token, shows Google's Picker and
 * downloads the chosen file itself (web/lib/drive.ts). None of that works in the app's webview,
 * and the room cannot be left to do it. So the room mints a drive ticket, the system browser's
 * start route spends it and sets a signed, HttpOnly pick cookie, and /connect/drive runs the
 * Picker there with the person's own Google session. It POSTs the pick (file id, name, size,
 * type, and the token) to /api/integrations/drive/app-pick, which seals it on the attempt. The
 * room, still live, polls GET /api/host/integrations/drive/app-pick/{id} with its session and
 * collects the pick once, then downloads the file as the web page does.
 */

// appConnectProviders are the {id} the app routes take.
var appConnectProviders = map[string]bool{"zoom": true, "youtube": true, "drive": true}

const (
	drivePickCookie = "webcast_drive_pick"
	drivePickIssuer = "webcast-drive-pick"
)

var (
	driveFileIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)
	uuidRe        = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// drivePickClaims ride in the pick cookie: whose attempt the system browser may finish.
type drivePickClaims struct {
	jwt.RegisteredClaims
	Handoff string `json:"handoff"`
	App     string `json:"app"`
}

// connectPayload is what an attempt parks for the app, sealed.
type connectPayload struct {
	Code  string                     `json:"code,omitempty"`
	Drive *types.AppDrivePickRequest `json:"drive,omitempty"`
}

/* connectKey seals parked payloads. Derived from SESSION_SECRET, which every deployment has
 * and which already signs the OAuth states, under its own label so it is not the same key. */
func (s *Server) connectKey() []byte {
	m := hmac.New(sha256.New, []byte(s.cfg.SessionSecret))
	m.Write([]byte("webinarliv app-connect handoff v1"))
	return m.Sum(nil)
}

func (s *Server) sealConnect(p connectPayload) ([]byte, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return zoom.Seal(s.connectKey(), string(b))
}

func (s *Server) openConnect(blob []byte) (connectPayload, error) {
	var p connectPayload
	plain, err := zoom.Open(s.connectKey(), blob)
	if err != nil {
		return p, err
	}
	err = json.Unmarshal([]byte(plain), &p)
	return p, err
}

// oauthErrorWord is the one word a provider's ?error= becomes on the way back to the app.
func oauthErrorWord(gerr string) string {
	if gerr == "access_denied" {
		return "denied"
	}
	return "provider"
}

/* connectReturnURL is the system browser's last stop: /connect/app-return#code=… or #error=…,
 * which opens webinarliv://connect/complete. The fragment keeps both out of server logs. */
func (s *Server) connectReturnURL(r *http.Request, app, provider string, v url.Values) string {
	v.Set("app", app)
	v.Set("provider", provider)
	return s.googleOrigin(r) + "/connect/app-return#" + v.Encode()
}

// appConnectFailed sends the system browser back to the app with why.
func (s *Server) appConnectFailed(w http.ResponseWriter, r *http.Request, provider, app, word string) {
	if !appAuthApps[app] {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "That link is not valid. Start again from the app.")
		return
	}
	http.Redirect(w, r, s.connectReturnURL(r, app, provider, url.Values{"error": {word}}), http.StatusFound) // #nosec G710 -- googleOrigin is an allowlisted origin
}

/* hostOrRefuse answers 403 for an account without hosting, as requireHost does, and says whether
 * the caller may go on. Zoom and YouTube are hosting integrations; the routes sit outside
 * requireHost only because a panelist uses the Drive half. */
func hostOrRefuse(w http.ResponseWriter, user store.User) bool {
	if user.CanHost {
		return true
	}
	httpx.Error(w, http.StatusForbidden, "not_a_host",
		"This account can't host webinars. An administrator has to grant hosting access.")
	return false
}

// connectStoreError maps a ticket or code lookup to the word the app shows.
func connectStoreError(err error) string {
	switch {
	case errors.Is(err, store.ErrAppCodeExpired):
		return "expired"
	case errors.Is(err, store.ErrAppCodeUsed):
		return "used"
	default:
		return "invalid"
	}
}

/* handleAppConnectTicket is POST /api/host/integrations/{id}/app-ticket, from the app's
 * webview: a ticket for the system browser to start {id}'s connect with. */
func (s *Server) handleAppConnectTicket(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	provider := chi.URLParam(r, "id")
	if !appConnectProviders[provider] {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such integration.")
		return
	}
	var req types.AppConnectTicketRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if !appAuthApps[req.App] {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "This only works from the Webinar Liv app.")
		return
	}
	if provider != "drive" && !hostOrRefuse(w, user) {
		return
	}
	switch provider {
	case "zoom":
		if !s.featureAllowed(w, user, types.FeatureZoom) {
			return
		}
		if !s.zoomOn() {
			httpx.Error(w, http.StatusServiceUnavailable, "zoom_not_configured", "Zoom is not configured.")
			return
		}
	case "youtube":
		if !s.requireStreamOut(w, r, user.ID) {
			return
		}
		if s.youtube == nil || !s.youtube.Enabled() {
			httpx.Error(w, http.StatusServiceUnavailable, "youtube_oauth_unset", "YouTube linking is not set up on this instance.")
			return
		}
	case "drive":
		// Google Drive is Business and up (2 Nov 2026): no hand-off, so no token, without it.
		if !user.HasFeature(types.FeatureGoogleDrive) {
			httpx.Error(w, http.StatusForbidden, "feature_off", googleDriveMessage)
			return
		}
		if s.cfg.GoogleClientID == "" || s.cfg.GoogleAPIKey == "" {
			httpx.Error(w, http.StatusServiceUnavailable, "drive_unset", "Google Drive is not set up on this instance.")
			return
		}
	}
	raw, id, err := s.store.IssueAppConnectTicket(r.Context(), user.ID, provider, req.App, safeReturnPath(req.Return))
	if errors.Is(err, store.ErrAppConnectTooMany) {
		httpx.Error(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Please wait a while and try again.")
		return
	}
	if err != nil {
		s.fail(w, r, "app connect: ticket", err)
		return
	}
	q := url.Values{"ticket": {raw}, "app": {req.App}}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, types.AppConnectTicketResponse{
		StartURL: s.googleOrigin(r) + "/api/integrations/" + provider + "/app-start?" + q.Encode(),
		ID:       id,
	})
}

/* handleAppConnectStart is GET /api/integrations/{id}/app-start?ticket=…&app=…, in the system
 * browser, which has no session: the ticket stands in for it, once. */
func (s *Server) handleAppConnectStart(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "id")
	app := r.URL.Query().Get("app")
	if !appConnectProviders[provider] || !appAuthApps[app] {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "That link is not valid. Start again from the app.")
		return
	}
	ticket := strings.TrimSpace(r.URL.Query().Get("ticket"))
	if ticket == "" || len(ticket) > 128 {
		s.appConnectFailed(w, r, provider, app, "invalid")
		return
	}
	c, err := s.store.StartAppConnect(r.Context(), ticket, provider)
	if err != nil && !errors.Is(err, store.ErrNotFound) && !errors.Is(err, store.ErrAppCodeUsed) &&
		!errors.Is(err, store.ErrAppCodeExpired) {
		s.fail(w, r, "app connect: start", err)
		return
	}
	if err != nil {
		if errors.Is(err, store.ErrAppCodeUsed) {
			s.log.Warn("app connect: ticket reused", "provider", provider, "ip", httpx.ClientIP(r))
		}
		s.appConnectFailed(w, r, provider, app, connectStoreError(err))
		return
	}
	if c.App != app {
		s.appConnectFailed(w, r, provider, c.App, "invalid")
		return
	}
	user, err := s.store.UserByID(r.Context(), c.UserID)
	if errors.Is(err, store.ErrNotFound) {
		s.appConnectFailed(w, r, provider, app, "invalid")
		return
	}
	if err != nil {
		s.fail(w, r, "app connect: user", err)
		return
	}
	if provider != "drive" && !user.CanHost {
		s.appConnectFailed(w, r, provider, app, "unavailable")
		return
	}
	switch provider {
	case "zoom":
		if !user.HasFeature(types.FeatureZoom) || !s.zoomOn() {
			s.appConnectFailed(w, r, provider, app, "unavailable")
			return
		}
		s.zoomAuthRedirect(w, r, user, c.Return, c.App, c.ID)
	case "youtube":
		if s.youtube == nil || !s.youtube.Enabled() || !user.HasFeature(types.FeatureStreamOut) {
			s.appConnectFailed(w, r, provider, app, "unavailable")
			return
		}
		s.youtubeAuthRedirect(w, r, user.ID, c.Return, c.App, c.ID)
	case "drive":
		if !user.HasFeature(types.FeatureGoogleDrive) {
			s.appConnectFailed(w, r, provider, app, "unavailable")
			return
		}
		now := time.Now()
		signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, drivePickClaims{
			RegisteredClaims: jwt.RegisteredClaims{
				Subject:   user.ID,
				IssuedAt:  jwt.NewNumericDate(now),
				ExpiresAt: jwt.NewNumericDate(now.Add(store.AppConnectFlowTTL)),
				Issuer:    drivePickIssuer,
			},
			Handoff: c.ID,
			App:     c.App,
		}).SignedString([]byte(s.cfg.SessionSecret))
		if err != nil {
			s.fail(w, r, "app connect: sign drive pick", err)
			return
		}
		// Lax and only on the pick route: the picker page's own same-origin POST carries it.
		http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite set; Secure follows COOKIE_SECURE, on outside development
			Name:     drivePickCookie,
			Value:    signed,
			Path:     "/api/integrations/drive",
			Expires:  now.Add(store.AppConnectFlowTTL),
			HttpOnly: true,
			Secure:   s.cfg.CookieSecure,
			SameSite: http.SameSiteLaxMode,
		})
		http.Redirect(w, r, s.googleOrigin(r)+"/connect/drive?app="+url.QueryEscape(c.App), http.StatusFound) // #nosec G710 -- googleOrigin is an allowlisted origin
	}
}

/* parkAppConnectCode is the callback's half for an app state: no tokens here, in the system
 * browser. The provider's code waits, sealed, for the app's signed-in webview. cookieOK says
 * the state came back with the state cookie the start route set in this same browser. */
func (s *Server) parkAppConnectCode(w http.ResponseWriter, r *http.Request, provider, app, handoff, userID string, cookieOK bool) {
	if !appAuthApps[app] || !uuidRe.MatchString(handoff) {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "That link is not valid. Start again from the app.")
		return
	}
	if !cookieOK {
		s.log.Warn("app connect: callback without its state cookie", "provider", provider, "ip", httpx.ClientIP(r))
		s.appConnectFailed(w, r, provider, app, "state")
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" || len(code) > 2048 {
		s.appConnectFailed(w, r, provider, app, "provider")
		return
	}
	sealed, err := s.sealConnect(connectPayload{Code: code})
	if err != nil {
		s.fail(w, r, "app connect: seal", err)
		return
	}
	raw, err := s.store.AttachAppConnectResult(r.Context(), handoff, userID, sealed, true)
	if errors.Is(err, store.ErrAppCodeUsed) {
		s.log.Warn("app connect: callback replayed", "provider", provider, "user", userID)
		s.appConnectFailed(w, r, provider, app, "used")
		return
	}
	if err != nil {
		s.fail(w, r, "app connect: park", err)
		return
	}
	s.log.Info("app connect: hand-off", "provider", provider, "user", userID, "app", app)
	http.Redirect(w, r, s.connectReturnURL(r, app, provider, url.Values{"code": {raw}}), http.StatusFound) // #nosec G710 -- googleOrigin is an allowlisted origin
}

/* handleAppConnectComplete is POST /api/host/integrations/app/complete, from the app's
 * webview: the completion code for the provider's parked code, connected for this session's
 * account only. */
func (s *Server) handleAppConnectComplete(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	var req types.AppConnectCompleteRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" || len(code) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That link is not valid. Start again from the app.")
		return
	}
	c, err := s.store.RedeemAppConnectCode(r.Context(), code)
	switch {
	case errors.Is(err, store.ErrAppCodeExpired):
		httpx.Error(w, http.StatusBadRequest, "code_expired", "That took too long. Start again from the app.")
		return
	case errors.Is(err, store.ErrAppCodeUsed):
		s.log.Warn("app connect: code reused", "user", user.ID, "ip", httpx.ClientIP(r))
		httpx.Error(w, http.StatusBadRequest, "code_used", "That link was already used. Start again from the app.")
		return
	case errors.Is(err, store.ErrNotFound):
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That link is not valid. Start again from the app.")
		return
	case err != nil:
		s.fail(w, r, "app connect: redeem", err)
		return
	}
	if c.UserID != user.ID {
		// Spent already: whoever caught this link gets no second go, and nor does the owner.
		s.log.Warn("app connect: wrong account", "provider", c.Provider, "ticket_user", c.UserID, "user", user.ID)
		httpx.Error(w, http.StatusForbidden, "wrong_account",
			"This connection was started from a different Webinar Liv account. Start again from the account you want to connect.")
		return
	}
	if !hostOrRefuse(w, user) {
		return
	}
	p, err := s.openConnect(c.Payload)
	if err != nil || p.Code == "" {
		s.fail(w, r, "app connect: open", errors.Join(err, errors.New("no code")))
		return
	}
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	var next string
	switch c.Provider {
	case "zoom":
		providerFailed, err := s.zoomConnectCode(r.Context(), user, p.Code)
		if providerFailed {
			httpx.Error(w, http.StatusBadGateway, "connect_failed", "Zoom didn't accept that. Try connecting again.")
			return
		}
		if err != nil {
			s.fail(w, r, "app connect: zoom save", err)
			return
		}
		next = strings.TrimPrefix(s.zoomFront(safeReturnPath(c.Return), "connected"), base)
	case "youtube":
		detail, err := s.youtubeConnectCode(r.Context(), user, p.Code)
		if detail != "" {
			httpx.Error(w, http.StatusBadGateway, "connect_failed", "Google didn't accept that. Try connecting YouTube again.")
			return
		}
		if err != nil {
			s.fail(w, r, "app connect: youtube save", err)
			return
		}
		next = strings.TrimPrefix(s.youtubeFront(safeReturnPath(c.Return), "connected", ""), base)
	default:
		httpx.Error(w, http.StatusBadRequest, "invalid_code", "That link is not valid. Start again from the app.")
		return
	}
	httpx.JSON(w, http.StatusOK, types.AppConnectCompleteResponse{Provider: c.Provider, Next: safeGoogleNext(next)})
}

/* handleAppDrivePick is POST /api/integrations/drive/app-pick, from /connect/drive in the
 * system browser: the pick for the attempt its pick cookie names, once. */
func (s *Server) handleAppDrivePick(w http.ResponseWriter, r *http.Request) {
	ck, err := r.Cookie(drivePickCookie)
	var claims drivePickClaims
	if err == nil {
		_, err = jwt.ParseWithClaims(ck.Value, &claims,
			func(t *jwt.Token) (any, error) { return []byte(s.cfg.SessionSecret), nil },
			jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
			jwt.WithIssuer(drivePickIssuer),
			jwt.WithExpirationRequired(),
		)
	}
	if err != nil || claims.Subject == "" || !uuidRe.MatchString(claims.Handoff) {
		httpx.Error(w, http.StatusUnauthorized, "pick_expired", "This took too long. Start again from the app.")
		return
	}
	var req types.AppDrivePickRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.MimeType = strings.TrimSpace(req.MimeType)
	if !driveFileIDRe.MatchString(req.FileID) || len(req.Name) > 500 || len(req.MimeType) > 200 ||
		req.Size < 0 || req.AccessToken == "" || len(req.AccessToken) > 4096 ||
		strings.ContainsAny(req.AccessToken, " \t\r\n") {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "That file could not be handed over.")
		return
	}
	sealed, err := s.sealConnect(connectPayload{Drive: &req})
	if err != nil {
		s.fail(w, r, "app drive pick: seal", err)
		return
	}
	if _, err := s.store.AttachAppConnectResult(r.Context(), claims.Handoff, claims.Subject, sealed, false); errors.Is(err, store.ErrAppCodeUsed) {
		httpx.Error(w, http.StatusConflict, "pick_used", "A file was already sent for this. Start again from the app.")
		return
	} else if err != nil {
		s.fail(w, r, "app drive pick: park", err)
		return
	}
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly and SameSite set; Secure follows COOKIE_SECURE, on outside development
		Name: drivePickCookie, Value: "", Path: "/api/integrations/drive", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
	s.log.Info("app drive pick: handed over", "user", claims.Subject, "app", claims.App)
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok", "app": claims.App})
}

/* handleAppDrivePickResult is GET /api/host/integrations/drive/app-pick/{pick}: the room,
 * in the app, asking whether its pick has arrived. The pick and its token are given out
 * once, to the account that minted the ticket. */
func (s *Server) handleAppDrivePickResult(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	id := chi.URLParam(r, "pick")
	w.Header().Set("Cache-Control", "private, no-store")
	if !uuidRe.MatchString(id) {
		httpx.Error(w, http.StatusNotFound, "pick_gone", "That choice is no longer waiting. Start again.")
		return
	}
	c, err := s.store.TakeAppConnectPick(r.Context(), id, user.ID)
	if errors.Is(err, store.ErrAppConnectPending) {
		httpx.JSON(w, http.StatusOK, types.AppDrivePickResponse{Status: "pending"})
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "pick_gone", "That choice is no longer waiting. Start again.")
		return
	}
	if err != nil {
		s.fail(w, r, "app drive pick: take", err)
		return
	}
	p, err := s.openConnect(c.Payload)
	if err != nil || p.Drive == nil {
		s.fail(w, r, "app drive pick: open", errors.Join(err, errors.New("no pick")))
		return
	}
	d := p.Drive
	httpx.JSON(w, http.StatusOK, types.AppDrivePickResponse{
		Status: "picked", FileID: d.FileID, Name: d.Name, Size: d.Size, MimeType: d.MimeType, AccessToken: d.AccessToken,
	})
}
