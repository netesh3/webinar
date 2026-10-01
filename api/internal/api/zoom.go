package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/integrations"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

const zoomStateCookie = "webcast_zoom"

/* errZoomFeatureOff is a host asking Zoom to do something this account has
 * not been allowed to do. The HTTP handlers answer 403 feature_off. A hidden
 * card is not the control. */
var errZoomFeatureOff = errors.New("zoom feature off")

type zoomState struct {
	jwt.RegisteredClaims
	Return string `json:"return"`
}

func (s *Server) zoomOn() bool {
	return s.zoom != nil && s.zoom.Enabled() && len(s.zoomKey) == 32
}

func (s *Server) zoomFlow() *zoom.Flow {
	if !s.zoomOn() {
		return nil
	}
	key := s.zoomKey
	return &zoom.Flow{
		Client: s.zoom,
		Repo:   zoomRepo{store: s.store},
		Seal:   func(plain string) ([]byte, error) { return zoom.Seal(key, plain) },
		Open:   func(blob []byte) (string, error) { return zoom.Open(key, blob) },
		Log:    s.log,
	}
}

func (s *Server) zoomHooks() integrations.ZoomHooks {
	h := integrations.ZoomHooks{Configured: s.zoomOn()}
	if !h.Configured {
		return h
	}
	h.Lookup = func(ctx context.Context, user store.User) (string, bool, error) {
		c, err := s.store.ZoomConnection(ctx, user.ID)
		if errors.Is(err, store.ErrNotFound) {
			return "", false, nil
		}
		if err != nil {
			return "", false, err
		}
		return c.Email, c.Invalid, nil
	}
	h.Disconnect = func(ctx context.Context, user store.User) error {
		if err := s.zoomFlow().Disconnect(ctx, user.ID); err != nil {
			return err
		}
		s.log.Info("zoom disconnected", "user", user.ID)
		return nil
	}
	return h
}

func (s *Server) handleZoomConnect(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !s.featureAllowed(w, user, types.FeatureZoom) {
		return
	}
	if !s.zoomOn() {
		httpx.Error(w, http.StatusServiceUnavailable, "zoom_not_configured", "Zoom is not configured.")
		return
	}
	ret := safeReturnPath(r.URL.Query().Get("return"))
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, zoomState{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
			Issuer:    "webcast-zoom",
		},
		Return: ret,
	})
	signed, err := tok.SignedString([]byte(s.cfg.SessionSecret))
	if err != nil {
		s.fail(w, r, "zoom connect: sign state", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     zoomStateCookie,
		Value:    signed,
		Path:     "/",
		Expires:  now.Add(10 * time.Minute),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: s.youtubeSameSite(),
	})
	http.Redirect(w, r, s.zoom.AuthCodeURL(s.cfg.ZoomRedirectURL, signed), http.StatusFound)
}

func (s *Server) handleZoomCallback(w http.ResponseWriter, r *http.Request) {
	ret := "/settings"
	fail := func(result string) {
		http.SetCookie(w, &http.Cookie{
			Name: zoomStateCookie, Value: "", Path: "/", MaxAge: -1,
			HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: s.youtubeSameSite(),
		})
		http.Redirect(w, r, s.zoomFront(ret, result), http.StatusFound)
	}
	if gerr := r.URL.Query().Get("error"); gerr != "" {
		if gerr == "access_denied" {
			fail("denied")
			return
		}
		fail("error")
		return
	}
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if ck, err := r.Cookie(zoomStateCookie); err == nil && ck.Value != "" {
		if state != "" && ck.Value != state {
			fail("error")
			return
		}
		if state == "" {
			state = ck.Value
		}
	}
	st, err := s.parseZoomState(state)
	if err != nil {
		fail("error")
		return
	}
	ret = safeReturnPath(st.Return)
	user, err := s.sessionUser(r)
	if err != nil || user.ID != st.Subject {
		fail("error")
		return
	}
	if !user.HasFeature(types.FeatureZoom) {
		fail("error")
		return
	}
	flow := s.zoomFlow()
	if flow == nil {
		fail("error")
		return
	}
	tok, err := s.zoom.Exchange(r.Context(), s.cfg.ZoomRedirectURL, r.URL.Query().Get("code"))
	if err != nil {
		s.log.Warn("zoom oauth exchange", "user", user.ID, "status", zoomStatus(err))
		fail("error")
		return
	}
	account, err := s.zoom.Me(r.Context(), tok.AccessToken)
	if err != nil {
		s.log.Warn("zoom oauth profile", "user", user.ID, "status", zoomStatus(err))
		fail("error")
		return
	}
	if err := flow.StoreGrant(r.Context(), user.ID, account, tok); err != nil {
		s.fail(w, r, "zoom oauth: save", err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: zoomStateCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: s.youtubeSameSite(),
	})
	s.log.Info("zoom connected", "user", user.ID, "zoomUser", account.ID)
	http.Redirect(w, r, s.zoomFront(ret, "connected"), http.StatusFound)
}

func (s *Server) parseZoomState(raw string) (zoomState, error) {
	var st zoomState
	_, err := jwt.ParseWithClaims(raw, &st,
		func(t *jwt.Token) (any, error) { return []byte(s.cfg.SessionSecret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer("webcast-zoom"),
		jwt.WithExpirationRequired(),
	)
	if err != nil || st.Subject == "" {
		return zoomState{}, errors.New("invalid zoom oauth state")
	}
	return st, nil
}

func (s *Server) zoomFront(path, result string) string {
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	frag := ""
	if i := strings.Index(path, "#"); i >= 0 {
		frag = path[i+1:]
		path = path[:i]
	}
	u, err := url.Parse(base + path)
	if err != nil {
		u, _ = url.Parse(base + "/settings")
	}
	q := u.Query()
	if result != "" {
		q.Set("zoom", result)
	}
	u.RawQuery = q.Encode()
	u.Fragment = frag
	return u.String()
}

/* handleZoomWebhook is the public seam Zoom calls.
 *
 * This pass handles the CRC check and app_deauthorized (delete the host's
 * tokens). Attendance, polls, Q&A, and recordings are phase 4: those events
 * are acknowledged so Zoom does not retry, and nothing else is done with them.
 */
func (s *Server) handleZoomWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if err := zoom.VerifySignature(
		s.cfg.ZoomWebhookSecret,
		r.Header.Get("x-zm-request-timestamp"),
		r.Header.Get("x-zm-signature"),
		body,
		time.Now(),
	); err != nil {
		s.log.Warn("zoom webhook rejected")
		httpx.Error(w, http.StatusUnauthorized, "zoom_signature", "Zoom webhook signature was not accepted.")
		return
	}
	var env struct {
		Event   string          `json:"event"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	switch env.Event {
	case "endpoint.url_validation":
		var p struct {
			PlainToken string `json:"plainToken"`
		}
		_ = json.Unmarshal(env.Payload, &p)
		httpx.JSON(w, http.StatusOK, map[string]string{
			"plainToken":     p.PlainToken,
			"encryptedToken": zoom.ValidationToken(s.cfg.ZoomWebhookSecret, p.PlainToken),
		})
	case "app_deauthorized":
		var p struct {
			UserID string `json:"user_id"`
		}
		_ = json.Unmarshal(env.Payload, &p)
		if s.zoomOn() && p.UserID != "" {
			if err := s.zoomFlow().Deauthorize(r.Context(), p.UserID); err != nil {
				s.log.Warn("zoom deauthorize", "error", err)
				httpx.Error(w, http.StatusInternalServerError, "zoom", "Could not remove the Zoom connection.")
				return
			}
			s.log.Info("zoom deauthorized", "zoomUser", p.UserID)
		}
		w.WriteHeader(http.StatusOK)
	default:
		/* Phase 4: meeting.ended, webinar.ended, participant_joined,
		 * participant_left, recording.completed. */
		w.WriteHeader(http.StatusOK)
	}
}

/* resolveZoom runs before a webinar is saved. A plan error rewrites the venue
 * to this app and sets Notice. A missing connection is a field error and does
 * not call Zoom.
 */
func (s *Server) resolveZoom(ctx context.Context, hostID, slug string, in *types.WebinarInput) (zoom.Saved, map[string]string, error) {
	prev := zoom.Object{}
	pushed := 0
	if slug != "" {
		if wb, err := s.store.WebinarBySlug(ctx, slug); err == nil {
			prev.Venue = wb.Venue
			prev.ID = wb.ZoomID
			if zoom.IsVenue(wb.Venue) && wb.ZoomID != "" {
				pushed, _ = s.store.ZoomPushedCount(ctx, slug)
				if u, err := s.store.ZoomStartURL(ctx, slug); err == nil {
					prev.StartURL = u
				}
				if u, err := s.store.ZoomMeetingJoin(ctx, slug); err == nil {
					prev.JoinURL = u
				}
			}
		}
	}
	if !zoom.IsVenue(in.Venue) && !zoom.IsVenue(prev.Venue) {
		return zoom.Saved{Venue: zoom.VenueApp}, nil, nil
	}
	/* The switch is the host's, not whoever pressed save. Off refuses a Zoom
	 * venue and, when the save is leaving Zoom, drops it locally without
	 * calling Zoom. */
	if hostID != "" && !s.hostHasZoom(ctx, hostID) {
		if zoom.IsVenue(in.Venue) {
			return zoom.Saved{}, nil, errZoomFeatureOff
		}
		return zoom.Saved{Venue: zoom.VenueApp}, nil, nil
	}
	flow := s.zoomFlow()
	if zoom.IsVenue(in.Venue) && flow == nil {
		return zoom.Saved{}, map[string]string{"venue": "Zoom is not configured."}, nil
	}
	if flow == nil {
		return zoom.Saved{Venue: zoom.VenueApp}, nil, nil
	}
	starts, _ := time.Parse(time.RFC3339, in.StartsAt)
	saved, err := flow.Save(ctx, hostID, zoom.Spec{
		Venue: in.Venue, Topic: in.Topic, StartsAt: starts, DurationMin: in.Duration, TimeZone: in.TimeZone,
	}, prev, pushed)
	if errors.Is(err, zoom.ErrNotConnected) {
		return zoom.Saved{}, map[string]string{"venue": "Connect Zoom in Settings before choosing it."}, nil
	}
	if errors.Is(err, zoom.ErrSwitch) {
		return zoom.Saved{}, map[string]string{"venue": "People already have personal Zoom links, so this can't switch between a meeting and a webinar."}, nil
	}
	if err != nil {
		return zoom.Saved{}, nil, err
	}
	in.Venue = saved.Venue
	return saved, nil, nil
}

func (s *Server) persistZoom(ctx context.Context, slug string, saved zoom.Saved) error {
	if saved.Venue == "" {
		saved.Venue = zoom.VenueApp
	}
	return s.store.SetWebinarZoom(ctx, slug, saved.Venue, saved.ZoomID, saved.StartURL, saved.JoinURL)
}

func (s *Server) pushZoomRegistrant(ctx context.Context, wb types.Webinar, regID, email, first, last string) {
	if !zoom.IsVenue(wb.Venue) || wb.ZoomID == "" || regID == "" {
		return
	}
	/* Registration still succeeds in this app. Zoom is not told about the
	 * person when the host's switch is off — the same refusal as connect. */
	if !s.hostHasZoom(ctx, wb.Host.ID) {
		return
	}
	flow := s.zoomFlow()
	if flow == nil {
		_ = s.store.SaveZoomRegistrant(ctx, regID, "", "", "Zoom is not configured, so this person has no Zoom link.")
		return
	}
	shared := ""
	if wb.Venue == zoom.VenueMeeting {
		if u, err := s.store.ZoomMeetingJoin(ctx, wb.ID); err == nil {
			shared = u
		}
	}
	if err := flow.Push(ctx, wb.Host.ID, wb.Venue, wb.ZoomID, regID, email, first, last, shared); err != nil {
		status, code, msg := zoom.ErrorParts(err)
		s.log.Warn("zoom registrant", "webinar", wb.ID, "registration", regID, "status", status, "code", code, "zoom", msg)
	}
}

func (s *Server) zoomGoLive(w http.ResponseWriter, r *http.Request, wb types.Webinar) {
	if !s.requireHostFeature(w, r, wb.Host.ID, types.FeatureZoom) {
		return
	}
	flow := s.zoomFlow()
	if flow == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "zoom_not_configured", "Zoom is not configured.")
		return
	}
	startURL, err := flow.GoLive(r.Context(), wb.Host.ID, wb.Venue, wb.ZoomID)
	if zoomWriteErr(w, err) {
		s.log.Warn("zoom go live", "webinar", wb.ID, "status", zoomStatus(err))
		return
	}
	if err := s.store.SetZoomStartURL(r.Context(), wb.ID, startURL); err != nil {
		s.fail(w, r, "zoom go live: save", err)
		return
	}
	s.log.Info("zoom go live", "webinar", wb.ID)
	httpx.JSON(w, http.StatusOK, struct {
		types.Webinar
		ZoomStartURL string `json:"zoomStartUrl"`
	}{Webinar: wb, ZoomStartURL: startURL})
}

func (s *Server) joinZoomAttendee(w http.ResponseWriter, r *http.Request, wb types.Webinar, reg types.Registration) {
	u, err := s.store.RegistrationZoomJoin(r.Context(), reg.ID)
	if err != nil || u == "" {
		msg := "Your Zoom link isn't ready. Register with an email, or ask the host to check their Zoom connection."
		if note, nerr := s.store.ZoomPushNote(r.Context(), reg.ID); nerr == nil && note != "" {
			msg = note
		}
		httpx.Error(w, http.StatusConflict, "zoom_link_missing", msg)
		return
	}
	httpx.JSON(w, http.StatusOK, types.JoinResponse{ZoomJoinURL: u, Topic: wb.Topic})
}

func (s *Server) hostHasZoom(ctx context.Context, hostID string) bool {
	if hostID == "" {
		return false
	}
	host, err := s.store.UserByID(ctx, hostID)
	if err != nil {
		s.log.Warn("zoom feature: load host", "host", hostID, "error", err)
		return false
	}
	return host.HasFeature(types.FeatureZoom)
}

func zoomWriteErr(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, zoom.ErrNotConfigured):
		httpx.Error(w, http.StatusServiceUnavailable, "zoom_not_configured", "Zoom is not configured.")
	case errors.Is(err, zoom.ErrNotConnected):
		httpx.Error(w, http.StatusUnprocessableEntity, "zoom_not_connected", "Connect Zoom in Settings, then try again.")
	default:
		var apiErr *zoom.APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusTooManyRequests {
			httpx.Error(w, http.StatusTooManyRequests, "zoom_rate", "Zoom is limiting requests. Nothing was retried.")
			return true
		}
		if errors.As(err, &apiErr) {
			httpx.Error(w, http.StatusBadGateway, "zoom", apiErr.Public())
			return true
		}
		httpx.Error(w, http.StatusBadGateway, "zoom", "Zoom could not complete that.")
	}
	return true
}

func zoomStatus(err error) int {
	var apiErr *zoom.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 0
}

type zoomRepo struct{ store *store.Store }

func (r zoomRepo) Connection(ctx context.Context, userID string) (zoom.Connection, error) {
	c, err := r.store.ZoomConnection(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		return zoom.Connection{}, zoom.ErrNotConnected
	}
	if err != nil {
		return zoom.Connection{}, err
	}
	return zoom.Connection{
		UserID: c.UserID, ZoomUserID: c.ZoomUserID, AccountID: c.AccountID,
		Email: c.Email, Refresh: c.Refresh, Invalid: c.Invalid,
	}, nil
}

func (r zoomRepo) SaveConnection(ctx context.Context, c zoom.Connection) error {
	return r.store.SaveZoomConnection(ctx, store.ZoomConnection{
		UserID: c.UserID, ZoomUserID: c.ZoomUserID, AccountID: c.AccountID,
		Email: c.Email, Refresh: c.Refresh,
	})
}

func (r zoomRepo) SaveRefresh(ctx context.Context, userID string, cipher []byte) error {
	return r.store.SaveZoomRefresh(ctx, userID, cipher)
}

func (r zoomRepo) MarkInvalid(ctx context.Context, userID string) error {
	return r.store.MarkZoomInvalid(ctx, userID)
}

func (r zoomRepo) DeleteConnection(ctx context.Context, userID string) error {
	return r.store.DeleteZoomConnection(ctx, userID)
}

func (r zoomRepo) DeleteByZoomUser(ctx context.Context, zoomUserID string) error {
	return r.store.DeleteZoomByZoomUser(ctx, zoomUserID)
}

func (r zoomRepo) SaveRegistrant(ctx context.Context, regID, registrantID, joinURL, note string) error {
	return r.store.SaveZoomRegistrant(ctx, regID, registrantID, joinURL, note)
}

func (r zoomRepo) RegistrantJoin(ctx context.Context, regID string) (string, error) {
	u, err := r.store.RegistrationZoomJoin(ctx, regID)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	return u, err
}

func (r zoomRepo) RegistrantRef(ctx context.Context, regID string) (string, string, error) {
	return r.store.RegistrationZoomRef(ctx, regID)
}

func (r zoomRepo) SaveMeetingJoin(ctx context.Context, zoomID, joinURL string) error {
	return r.store.SaveMeetingJoin(ctx, zoomID, joinURL)
}

func (r zoomRepo) PushedCount(ctx context.Context, slug string) (int, error) {
	return r.store.ZoomPushedCount(ctx, slug)
}
