package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/yt"
	"github.com/netkumar/webcast/api/types"
)

const youtubeStateCookie = "webcast_youtube"

type youtubeState struct {
	jwt.RegisteredClaims
	Return string `json:"return"`
}

func (s *Server) youtubeRedirectURI() string {
	return strings.TrimRight(s.cfg.WebBaseURL, "/") + "/api/host/youtube/callback"
}

func (s *Server) youtubeFront(path, result, detail string) string {
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	u, err := url.Parse(base + path)
	if err != nil {
		u, _ = url.Parse(base + "/account")
	}
	q := u.Query()
	if result != "" {
		q.Set("youtube", result)
	}
	if detail != "" {
		q.Set("detail", detail)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func safeReturnPath(raw string) string {
	p := strings.TrimSpace(raw)
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.Contains(p, "://") {
		return "/account"
	}
	if i := strings.IndexAny(p, "\r\n"); i >= 0 {
		p = p[:i]
	}
	return p
}

func (s *Server) handleYouTubeConnect(w http.ResponseWriter, r *http.Request) {
	if s.youtube == nil || !s.youtube.Enabled() {
		httpx.Error(w, http.StatusServiceUnavailable, "youtube_oauth_unset",
			"YouTube linking is not set up on this instance. Paste a stream key instead, or ask whoever runs this to set GOOGLE_CLIENT_SECRET.")
		return
	}

	user := userFromContext(r.Context())
	ret := safeReturnPath(r.URL.Query().Get("return"))
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, youtubeState{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(10 * time.Minute)),
			Issuer:    "webcast-youtube",
		},
		Return: ret,
	})
	signed, err := tok.SignedString([]byte(s.cfg.SessionSecret))
	if err != nil {
		s.fail(w, r, "youtube connect: sign state", err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     youtubeStateCookie,
		Value:    signed,
		Path:     "/",
		Expires:  now.Add(10 * time.Minute),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: s.youtubeSameSite(),
	})

	http.Redirect(w, r, s.youtube.AuthCodeURL(s.youtubeRedirectURI(), signed), http.StatusFound)
}

func (s *Server) youtubeSameSite() http.SameSite {
	if s.cfg.CookieSecure {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func (s *Server) handleYouTubeCallback(w http.ResponseWriter, r *http.Request) {
	ret := "/account"
	fail := func(result, detail string) {
		http.SetCookie(w, &http.Cookie{
			Name: youtubeStateCookie, Value: "", Path: "/", MaxAge: -1,
			HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: s.youtubeSameSite(),
		})
		http.Redirect(w, r, s.youtubeFront(ret, result, detail), http.StatusFound)
	}

	if gerr := r.URL.Query().Get("error"); gerr != "" {
		if gerr == "access_denied" {
			fail("denied", "")
			return
		}
		fail("error", "google")
		return
	}

	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if ck, err := r.Cookie(youtubeStateCookie); err == nil && ck.Value != "" {
		if state != "" && ck.Value != state {
			fail("error", "state")
			return
		}
		if state == "" {
			state = ck.Value
		}
	}
	st, err := s.parseYouTubeState(state)
	if err != nil {
		fail("error", "state")
		return
	}
	ret = safeReturnPath(st.Return)

	user, err := s.sessionUser(r)
	if err != nil || user.ID != st.Subject {
		fail("error", "session")
		return
	}

	if s.youtube == nil || !s.youtube.Enabled() {
		fail("error", "unset")
		return
	}

	tok, ch, err := s.youtube.Exchange(r.Context(), s.youtubeRedirectURI(), r.URL.Query().Get("code"))
	if err != nil {
		s.log.Warn("youtube oauth exchange", "error", err, "user", user.ID)
		fail("error", "exchange")
		return
	}

	if err := s.store.SetUserYouTube(r.Context(), user.ID, tok.RefreshToken, ch.ID, ch.Title, user.YouTubeStreamID); err != nil {
		s.fail(w, r, "youtube oauth: save", err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name: youtubeStateCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: s.youtubeSameSite(),
	})
	s.log.Info("youtube connected", "user", user.ID, "channel", ch.ID)
	http.Redirect(w, r, s.youtubeFront(ret, "connected", ""), http.StatusFound)
}

func (s *Server) parseYouTubeState(raw string) (youtubeState, error) {
	var st youtubeState
	_, err := jwt.ParseWithClaims(raw, &st,
		func(t *jwt.Token) (any, error) { return []byte(s.cfg.SessionSecret), nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer("webcast-youtube"),
		jwt.WithExpirationRequired(),
	)
	if err != nil || st.Subject == "" {
		return youtubeState{}, errors.New("invalid youtube oauth state")
	}
	return st, nil
}

func (s *Server) handleYouTubeDisconnect(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if s.youtube != nil && user.YouTubeRefresh != "" {
		if err := s.youtube.Revoke(r.Context(), user.YouTubeRefresh); err != nil {
			s.log.Warn("youtube revoke", "error", err, "user", user.ID)
		}
	}
	if err := s.store.SetUserYouTube(r.Context(), user.ID, "", "", "", ""); err != nil {
		s.fail(w, r, "youtube disconnect", err)
		return
	}
	updated, err := s.store.UserByID(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "youtube disconnect: reload", err)
		return
	}
	s.log.Info("youtube disconnected", "user", user.ID)
	httpx.JSON(w, http.StatusOK, updated.Public())
}

func (s *Server) applyYouTubeLive(ctx context.Context, wb types.Webinar, privacy string) (string, string, error) {
	if s.youtube == nil || !s.youtube.Enabled() {
		return "", "", yt.ErrNotConfigured
	}
	host, err := s.store.UserByID(ctx, wb.Host.ID)
	if err != nil {
		return "", "", err
	}
	if host.YouTubeRefresh == "" {
		return "", "", yt.ErrNeedRefresh
	}

	live, tok, err := s.youtube.StartLive(ctx, host.YouTubeRefresh, wb.Topic, privacy, host.YouTubeStreamID)
	if err != nil {
		return "", "", err
	}
	if tok.RefreshToken != "" && tok.RefreshToken != host.YouTubeRefresh {
		_ = s.store.SetUserYouTube(ctx, host.ID, tok.RefreshToken, host.YouTubeChannelID, host.YouTubeChannelTitle, live.StreamID)
	} else if live.StreamID != host.YouTubeStreamID {
		_ = s.store.SetUserYouTubeStreamID(ctx, host.ID, live.StreamID)
	}

	if err := s.store.SetWebinarStream(ctx, wb.ID, live.IngestURL, live.WatchURL, live.BroadcastID); err != nil {
		return "", "", err
	}
	return live.IngestURL, live.WatchURL, nil
}

func (s *Server) completeYouTubeBroadcast(ctx context.Context, slug string, hostID string) {
	id, err := s.store.WebinarYouTubeBroadcast(ctx, slug)
	if err != nil || id == "" {
		return
	}
	s.finishYouTubeBroadcast(ctx, id, hostID)
}

/* finishYouTubeBroadcast ends a broadcast by id rather than by looking one up.
 *
 * Stopping a stream clears youtube_broadcast_id, and the broadcast has to be
 * ended after the encoder has gone away rather than before — so by the time
 * this is the right thing to do, the webinar row no longer says which
 * broadcast it was. The caller holds onto the id across that gap. */
func (s *Server) finishYouTubeBroadcast(ctx context.Context, broadcastID, hostID string) {
	if broadcastID == "" || s.youtube == nil {
		return
	}
	host, err := s.store.UserByID(ctx, hostID)
	if err != nil || host.YouTubeRefresh == "" {
		return
	}
	if err := s.youtube.Complete(ctx, host.YouTubeRefresh, broadcastID); err != nil {
		s.log.Warn("youtube complete broadcast", "broadcast", broadcastID, "error", err)
	}
}

func youtubeAPIError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, yt.ErrNotConfigured):
		httpx.Error(w, http.StatusServiceUnavailable, "youtube_oauth_unset", err.Error())
	case errors.Is(err, yt.ErrNeedRefresh):
		httpx.Error(w, http.StatusUnprocessableEntity, "youtube_not_connected", err.Error())
	case errors.Is(err, yt.ErrLiveDisabled):
		httpx.Error(w, http.StatusUnprocessableEntity, "youtube_live_disabled", err.Error())
	case errors.Is(err, yt.ErrNoChannel):
		httpx.Error(w, http.StatusUnprocessableEntity, "youtube_no_channel", err.Error())
	default:
		return false
	}
	return true
}
