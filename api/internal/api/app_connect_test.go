package api_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Connect Zoom, Connect YouTube and the Drive picker from the apps (app_connect.go,
 * 29 Oct 2026): a ticket from the signed-in webview starts the OAuth in a system browser that
 * has no session, the callback parks the provider's code, and only the ticket's own account,
 * signed in to the app, can finish it. */

// fakeProviders stands in for Zoom's OAuth and API, and Google's token and YouTube endpoints.
type fakeProviders struct {
	zoomTokens atomic.Int32
	ytTokens   atomic.Int32
}

func withAppConnect(t *testing.T) (*fakeProviders, func(*config.Config)) {
	t.Helper()
	f := &fakeProviders{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			_ = r.ParseForm()
			if r.Form.Get("code") != "zoom-code" {
				http.Error(w, `{"reason":"bad code"}`, http.StatusBadRequest)
				return
			}
			f.zoomTokens.Add(1)
			_, _ = w.Write([]byte(`{"access_token":"zoom-access","refresh_token":"zoom-refresh","expires_in":3600}`))
		case "/users/me":
			_, _ = w.Write([]byte(`{"id":"zoom-user-1","account_id":"acct-1","email":"zoomer@test.dev"}`))
		case "/google/token":
			_ = r.ParseForm()
			if r.Form.Get("code") != "yt-code" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
			f.ytTokens.Add(1)
			_, _ = w.Write([]byte(`{"access_token":"yt-access","refresh_token":"yt-refresh","expires_in":3600}`))
		case "/yt/channels":
			_, _ = w.Write([]byte(`{"items":[{"id":"UC-test","snippet":{"title":"Test Channel"}}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return f, func(cfg *config.Config) {
		cfg.ZoomClientID = "cid"
		cfg.ZoomClientSecret = "sec"
		cfg.ZoomRedirectURL = "https://example.test/api/host/zoom/callback"
		cfg.ZoomTokenKey = "0123456789abcdef0123456789abcdef"
		cfg.ZoomAPIURL = srv.URL
		cfg.ZoomOAuthURL = srv.URL
		cfg.GoogleClientID = testGoogleClientID
		cfg.GoogleClientSecret = "test-google-client-secret"
		cfg.GoogleAPIKey = "test-api-key"
		cfg.YouTubeTokenURL = srv.URL + "/google/token"
		cfg.YouTubeAPIURL = srv.URL + "/yt"
	}
}

// systemBrowser is a fresh browser with its own cookies and none of the app's.
func systemBrowser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return noRedirects(&http.Client{Jar: jar})
}

func (h *harness) appTicket(provider, app, ret string) (*http.Response, types.AppConnectTicketResponse) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/integrations/"+provider+"/app-ticket",
		types.AppConnectTicketRequest{App: app, Return: ret})
	var out types.AppConnectTicketResponse
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &out)
	}
	return res, out
}

func get(t *testing.T, c *http.Client, raw string) *http.Response {
	t.Helper()
	res, err := c.Get(raw)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	return res
}

// location parses a redirect, and its fragment when it is the connect return page.
func location(t *testing.T, res *http.Response) (*url.URL, url.Values) {
	t.Helper()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("status %d, want a redirect", res.StatusCode)
	}
	u, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	frag, _ := url.ParseQuery(u.Fragment)
	return u, frag
}

/* startToProvider opens a ticket's start URL in browser and returns the state it sent the
 * provider. The start URL is absolute on the API's origin; the test server's is the same. */
func startToProvider(t *testing.T, h *harness, browser *http.Client, startURL string) string {
	t.Helper()
	u, err := url.Parse(startURL)
	if err != nil {
		t.Fatal(err)
	}
	loc, frag := location(t, get(t, browser, h.srv.URL+u.RequestURI()))
	if frag.Get("error") != "" {
		t.Fatalf("start went back to the app with %v", frag)
	}
	state := loc.Query().Get("state")
	if state == "" {
		t.Fatalf("start went to %s, want the provider with a state", loc)
	}
	return state
}

func (h *harness) completeConnect(code string) (*http.Response, []byte) {
	h.t.Helper()
	return h.do(http.MethodPost, "/api/host/integrations/app/complete", types.AppConnectCompleteRequest{Code: code})
}

func TestAppConnectZoomHandOff(t *testing.T) {
	f, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	host := h.signup("App Zoom Host", "app-zoom@test.dev", true)
	grantFeature(t, h, host.ID, types.FeatureZoom)

	res, ticket := h.appTicket("zoom", "desktop", "/settings#integrations")
	if res.StatusCode != http.StatusOK || ticket.ID == "" {
		t.Fatalf("ticket: %d", res.StatusCode)
	}
	start, _ := url.Parse(ticket.StartURL)
	raw := start.Query().Get("ticket")
	if start.Path != "/api/integrations/zoom/app-start" || start.Query().Get("app") != "desktop" || len(raw) < 32 {
		t.Fatalf("start URL %s", ticket.StartURL)
	}
	if n := h.pushCount(`SELECT count(*) FROM app_connect_handoffs WHERE ticket_hash = $1`, raw); n != 0 {
		t.Fatal("the raw ticket is in the database")
	}
	if n := h.pushCount(`SELECT count(*) FROM app_connect_handoffs
		WHERE expires_at BETWEEN now() + interval '100 seconds' AND now() + interval '121 seconds'`); n != 1 {
		t.Fatalf("tickets living about two minutes: %d", n)
	}

	browser := systemBrowser(t)
	state := startToProvider(t, h, browser, ticket.StartURL)
	res = get(t, browser, h.srv.URL+"/api/host/zoom/callback?code=zoom-code&state="+url.QueryEscape(state))
	back, frag := location(t, res)
	if back.Path != "/connect/app-return" || back.RawQuery != "" || frag.Get("provider") != "zoom" ||
		frag.Get("app") != "desktop" || len(frag.Get("code")) < 32 {
		t.Fatalf("callback went to %s", res.Header.Get("Location"))
	}
	for _, c := range res.Cookies() {
		if c.Name == "webcast_session" && c.Value != "" {
			t.Fatal("the system browser was given a session")
		}
	}
	// Nothing connected yet, and Zoom's code not even exchanged: that waits for the app.
	if _, err := h.store.ZoomConnection(context.Background(), host.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("connected before the app finished: %v", err)
	}
	if n := f.zoomTokens.Load(); n != 0 {
		t.Fatalf("zoom code exchanged %d times in the system browser", n)
	}
	if n := h.pushCount(`SELECT count(*) FROM app_connect_handoffs WHERE position('zoom-code'::bytea in payload) > 0`); n != 0 {
		t.Fatal("zoom's code is stored in the clear")
	}

	// The same callback again (a reload, a replay) parks nothing more.
	res = get(t, browser, h.srv.URL+"/api/host/zoom/callback?code=zoom-code&state="+url.QueryEscape(state))
	if _, again := location(t, res); again.Get("code") != "" {
		t.Fatalf("a replayed callback got another code: %v", again)
	}

	// The app's webview, signed in as the host, finishes it.
	res, body := h.completeConnect(frag.Get("code"))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("complete: %d %s", res.StatusCode, body)
	}
	var out types.AppConnectCompleteResponse
	h.decode(body, &out)
	if out.Provider != "zoom" || out.Next != "/settings?zoom=connected#integrations" {
		t.Fatalf("complete answer %+v", out)
	}
	conn, err := h.store.ZoomConnection(context.Background(), host.ID)
	if err != nil || conn.Email != "zoomer@test.dev" {
		t.Fatalf("zoom connection %+v, %v", conn, err)
	}
	if strings.Contains(string(body), "zoom-refresh") || strings.Contains(string(body), "zoom-access") {
		t.Fatal("a Zoom token is in the response")
	}

	res, body = h.completeConnect(frag.Get("code"))
	wantCode(t, res, body, http.StatusBadRequest, "code_used")
	if n := f.zoomTokens.Load(); n != 1 {
		t.Fatalf("zoom code exchanged %d times, want 1", n)
	}
}

// A ticket for account A finished in account B's app connects nobody, and spends the code.
func TestAppConnectWrongAccountIsRefused(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	a := h.signup("Ticket Owner", "owner-a@test.dev", true)
	grantFeature(t, h, a.ID, types.FeatureZoom)
	_, ticket := h.appTicket("zoom", "ios", "")

	browser := systemBrowser(t)
	state := startToProvider(t, h, browser, ticket.StartURL)
	_, frag := location(t, get(t, browser, h.srv.URL+"/api/host/zoom/callback?code=zoom-code&state="+url.QueryEscape(state)))
	code := frag.Get("code")

	h.logout()
	b := h.signup("Somebody Else", "other-b@test.dev", true)
	grantFeature(t, h, b.ID, types.FeatureZoom)
	res, body := h.completeConnect(code)
	wantCode(t, res, body, http.StatusForbidden, "wrong_account")
	for _, id := range []string{a.ID, b.ID} {
		if _, err := h.store.ZoomConnection(context.Background(), id); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("%s got a Zoom connection: %v", id, err)
		}
	}
	// Spent: not even the right account can use it now.
	h.logout()
	h.login("owner-a@test.dev")
	res, body = h.completeConnect(code)
	wantCode(t, res, body, http.StatusBadRequest, "code_used")
}

func TestAppConnectTicketIsSingleUseAndExpires(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	host := h.signup("Ticket Host", "ticket-host@test.dev", true)
	grantFeature(t, h, host.ID, types.FeatureZoom)

	startErr := func(startURL string) string {
		t.Helper()
		u, _ := url.Parse(startURL)
		back, frag := location(t, get(t, systemBrowser(t), h.srv.URL+u.RequestURI()))
		if back.Path != "/connect/app-return" {
			return ""
		}
		return frag.Get("error")
	}

	// Used once.
	_, ticket := h.appTicket("zoom", "android", "")
	if e := startErr(ticket.StartURL); e != "" {
		t.Fatalf("first start: %s", e)
	}
	if e := startErr(ticket.StartURL); e != "used" {
		t.Fatalf("second start: %q, want used", e)
	}

	// A zoom ticket does not start YouTube, and is not spent by trying.
	_, ticket = h.appTicket("zoom", "android", "")
	if e := startErr(strings.Replace(ticket.StartURL, "/zoom/", "/youtube/", 1)); e != "invalid" {
		t.Fatalf("zoom ticket at youtube: %q, want invalid", e)
	}
	// Nor with another app's name on it.
	if e := startErr(strings.Replace(ticket.StartURL, "app=android", "app=ios", 1)); e != "invalid" {
		t.Fatalf("android ticket as ios: %q, want invalid", e)
	}

	// Too old.
	_, ticket = h.appTicket("zoom", "android", "")
	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE app_connect_handoffs SET expires_at = now() - interval '1 second' WHERE started_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if e := startErr(ticket.StartURL); e != "expired" {
		t.Fatalf("expired ticket: %q", e)
	}
	// Never issued.
	if e := startErr(h.srv.URL + "/api/integrations/zoom/app-start?app=ios&ticket=" + strings.Repeat("ab", 32)); e != "invalid" {
		t.Fatalf("unknown ticket: %q", e)
	}

	// Only from an app, for a provider this route knows, and Zoom only for an account with it.
	if res, _ := h.appTicket("zoom", "web", ""); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("ticket for app=web: %d", res.StatusCode)
	}
	if res, _ := h.appTicket("slack", "ios", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("ticket for slack: %d", res.StatusCode)
	}
	h.logout()
	h.signup("No Zoom", "no-zoom@test.dev", true)
	if res, _ := h.appTicket("zoom", "ios", ""); res.StatusCode != http.StatusForbidden {
		t.Fatalf("zoom ticket without the feature: %d", res.StatusCode)
	}
	h.logout()
	h.signup("Not A Host", "not-a-host@test.dev", false)
	res, body := h.do(http.MethodPost, "/api/host/integrations/youtube/app-ticket", types.AppConnectTicketRequest{App: "ios"})
	wantCode(t, res, body, http.StatusForbidden, "not_a_host")
	h.logout()
	if res, _ := h.appTicket("zoom", "ios", ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("ticket without a session: %d", res.StatusCode)
	}
}

func TestAppConnectTicketsAreRateLimited(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	host := h.signup("Busy Host", "busy-host@test.dev", true)

	// The account's hourly budget.
	if _, err := h.store.Pool().Exec(context.Background(), `
		INSERT INTO app_connect_handoffs (ticket_hash, user_id, provider, app, expires_at)
		SELECT 'fill-' || g, $1::uuid, 'youtube', 'ios', now() FROM generate_series(1, $2) g`,
		host.ID, store.AppConnectTicketsPerHour); err != nil {
		t.Fatal(err)
	}
	res, body := h.do(http.MethodPost, "/api/host/integrations/youtube/app-ticket", types.AppConnectTicketRequest{App: "ios"})
	wantCode(t, res, body, http.StatusTooManyRequests, "rate_limited")

	// And per IP, before the database is asked.
	limited := false
	for i := 0; i < 22; i++ {
		res, _ := h.appTicket("youtube", "ios", "")
		if res.StatusCode == http.StatusTooManyRequests && res.Header.Get("Retry-After") != "" {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("twenty-odd tickets a minute from one IP were all answered")
	}
}

// The callback of an app connect must come back to the browser that spent the ticket.
func TestAppConnectCallbackNeedsTheStateCookie(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	host := h.signup("Cookie Host", "cookie-host@test.dev", true)
	grantFeature(t, h, host.ID, types.FeatureZoom)
	_, ticket := h.appTicket("zoom", "desktop", "")
	state := startToProvider(t, h, systemBrowser(t), ticket.StartURL)

	// A different browser (the state link forwarded to somebody) gets nothing.
	_, frag := location(t, get(t, systemBrowser(t), h.srv.URL+"/api/host/zoom/callback?code=zoom-code&state="+url.QueryEscape(state)))
	if frag.Get("error") != "state" || frag.Get("code") != "" {
		t.Fatalf("callback without the cookie: %v", frag)
	}
	if n := h.pushCount(`SELECT count(*) FROM app_connect_handoffs WHERE payload IS NOT NULL OR code_hash IS NOT NULL`); n != 0 {
		t.Fatal("a code was parked for a callback without its cookie")
	}
}

// Cancelling at the provider goes back to the app with status error, not to a settings page.
func TestAppConnectDeniedReturnsToTheApp(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	h.signup("Denied Host", "denied-host@test.dev", true)
	_, ticket := h.appTicket("youtube", "ios", "/host/demo/room")
	browser := systemBrowser(t)
	state := startToProvider(t, h, browser, ticket.StartURL)
	res := get(t, browser, h.srv.URL+"/api/host/youtube/callback?error=access_denied&state="+url.QueryEscape(state))
	back, frag := location(t, res)
	if back.Path != "/connect/app-return" || frag.Get("error") != "denied" || frag.Get("provider") != "youtube" ||
		frag.Get("app") != "ios" || frag.Get("code") != "" {
		t.Fatalf("denied went to %s", res.Header.Get("Location"))
	}
	// The web flow's own denial is unchanged.
	res = get(t, browser, h.srv.URL+"/api/host/youtube/callback?error=access_denied")
	if back, _ := location(t, res); back.Path != "/settings" || back.Query().Get("youtube") != "denied" {
		t.Fatalf("web denial went to %s", res.Header.Get("Location"))
	}
}

func TestAppConnectYouTubeStoresTheRightAccount(t *testing.T) {
	f, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	other := h.signup("Bystander", "bystander@test.dev", true)
	h.logout()
	host := h.signup("App YouTube Host", "app-yt@test.dev", true)

	_, ticket := h.appTicket("youtube", "android", "/host/demo/room")
	browser := systemBrowser(t)
	state := startToProvider(t, h, browser, ticket.StartURL)
	_, frag := location(t, get(t, browser, h.srv.URL+"/api/host/youtube/callback?code=yt-code&state="+url.QueryEscape(state)))
	if n := f.ytTokens.Load(); n != 0 {
		t.Fatal("google code exchanged in the system browser")
	}
	res, body := h.completeConnect(frag.Get("code"))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("complete: %d %s", res.StatusCode, body)
	}
	var out types.AppConnectCompleteResponse
	h.decode(body, &out)
	if out.Provider != "youtube" || out.Next != "/host/demo/room?youtube=connected" {
		t.Fatalf("complete answer %+v", out)
	}
	got, err := h.store.UserByID(context.Background(), host.ID)
	if err != nil || got.YouTubeChannelID != "UC-test" || got.YouTubeRefresh != "yt-refresh" {
		t.Fatalf("host youtube: channel %q, %v", got.YouTubeChannelID, err)
	}
	if by, _ := h.store.UserByID(context.Background(), other.ID); by.YouTubeChannelID != "" {
		t.Fatal("the bystander got the channel")
	}
}

// A provider that refuses the parked code at completion is an error the app shows.
func TestAppConnectProviderErrorAtCompletion(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	host := h.signup("Bad Code Host", "bad-code@test.dev", true)
	_, ticket := h.appTicket("youtube", "desktop", "")
	browser := systemBrowser(t)
	state := startToProvider(t, h, browser, ticket.StartURL)
	_, frag := location(t, get(t, browser, h.srv.URL+"/api/host/youtube/callback?code=stale&state="+url.QueryEscape(state)))
	res, body := h.completeConnect(frag.Get("code"))
	wantCode(t, res, body, http.StatusBadGateway, "connect_failed")
	if got, _ := h.store.UserByID(context.Background(), host.ID); got.YouTubeChannelID != "" {
		t.Fatal("connected on a refused code")
	}
}

func TestAppDrivePickHandOff(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	h.signup("Drive Bystander", "drive-other@test.dev", true)
	h.logout()
	// Not a host: a panelist shares a Drive video from the stage as well.
	h.signup("Drive Panelist", "drive-host@test.dev", false)
	// Google Drive is Business and up (0183): this account has it, as an override.
	forceFeature(t, h, h.me().ID, types.FeatureGoogleDrive, true)

	_, ticket := h.appTicket("drive", "android", "")
	poll := func() (*http.Response, types.AppDrivePickResponse) {
		t.Helper()
		res, body := h.do(http.MethodGet, "/api/host/integrations/drive/app-pick/"+ticket.ID, nil)
		var out types.AppDrivePickResponse
		if res.StatusCode == http.StatusOK {
			h.decode(body, &out)
		}
		return res, out
	}
	if res, out := poll(); res.StatusCode != http.StatusOK || out.Status != "pending" {
		t.Fatalf("poll before start: %d %+v", res.StatusCode, out)
	}

	browser := systemBrowser(t)
	u, _ := url.Parse(ticket.StartURL)
	back, _ := location(t, get(t, browser, h.srv.URL+u.RequestURI()))
	if back.Path != "/connect/drive" || back.Query().Get("app") != "android" {
		t.Fatalf("drive start went to %s", back)
	}

	pick := types.AppDrivePickRequest{
		FileID: "1AbC_def-GHI", Name: "Demo.mp4", Size: 1234, MimeType: "video/mp4", AccessToken: "ya29.drive-token",
	}
	send := func(c *http.Client, body types.AppDrivePickRequest) *http.Response {
		t.Helper()
		other := &harness{t: t, srv: h.srv, client: c}
		res, _ := other.do(http.MethodPost, "/api/integrations/drive/app-pick", body)
		return res
	}
	// Without the pick cookie (another browser), refused.
	if res := send(systemBrowser(t), pick); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("pick without the cookie: %d", res.StatusCode)
	}
	bad := pick
	bad.FileID = "../../etc"
	if res := send(browser, bad); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad file id: %d", res.StatusCode)
	}
	if res := send(browser, pick); res.StatusCode != http.StatusOK {
		t.Fatalf("pick: %d", res.StatusCode)
	}
	// Once: the cookie is gone and the attempt has its pick.
	if res := send(browser, pick); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("second pick: %d", res.StatusCode)
	}
	if n := h.pushCount(`SELECT count(*) FROM app_connect_handoffs WHERE position('ya29'::bytea in payload) > 0`); n != 0 {
		t.Fatal("the Drive token is stored in the clear")
	}

	// Another account cannot collect it.
	h.logout()
	h.login("drive-other@test.dev")
	if res, _ := poll(); res.StatusCode != http.StatusNotFound {
		t.Fatalf("another account's poll: %d", res.StatusCode)
	}
	h.logout()
	h.login("drive-host@test.dev")
	res, out := poll()
	if res.StatusCode != http.StatusOK || out.Status != "picked" || out.FileID != pick.FileID ||
		out.AccessToken != pick.AccessToken || out.Name != "Demo.mp4" || out.Size != 1234 {
		t.Fatalf("poll after the pick: %d %+v", res.StatusCode, out)
	}
	if res, _ := poll(); res.StatusCode != http.StatusNotFound {
		t.Fatalf("second collection: %d", res.StatusCode)
	}
	if n := h.pushCount(`SELECT count(*) FROM app_connect_handoffs WHERE payload IS NOT NULL`); n != 0 {
		t.Fatal("the pick outlived its collection")
	}
}
