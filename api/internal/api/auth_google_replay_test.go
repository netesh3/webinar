package api_test

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/auth"
)

/* A Google callback the browser sends twice (auth_google_replay.go, 31 Oct 2026): the repeat
 * gets the first one's answer, and Google is asked once. */

// googleStart runs /api/auth/google/start on browser and returns the signed state, pointing
// the fake Google's ID token at the nonce that start asked for.
func googleStart(t *testing.T, h *harness, g *fakeGoogleFor, browser *http.Client, q url.Values) string {
	t.Helper()
	res, err := browser.Get(h.srv.URL + "/api/auth/google/start?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("start: status %d", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.nonce = loc.Query().Get("nonce")
	g.mu.Unlock()
	return loc.Query().Get("state")
}

// googleCallback sends Google's redirect, plus any extra cookies, and returns the response.
func googleCallback(t *testing.T, h *harness, browser *http.Client, state, code string, cookies ...*http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet,
		h.srv.URL+"/api/auth/google/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := browser.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("callback: status %d", res.StatusCode)
	}
	return res
}

// appCodeOf is the hand-off code in a callback's /auth/app-return Location.
func appCodeOf(t *testing.T, res *http.Response) string {
	t.Helper()
	back, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	frag, _ := url.ParseQuery(back.Fragment)
	if back.Path != "/auth/app-return" || frag.Get("code") == "" || frag.Get("error") != "" {
		t.Fatalf("callback went to %s, want an app hand-off", res.Header.Get("Location"))
	}
	return frag.Get("code")
}

func sessionCookieOf(res *http.Response) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			return c
		}
	}
	return nil
}

func appStartQuery(verifier string) url.Values {
	return url.Values{"next": {"/"}, "app": {"desktop"}, "challenge": {api.ChallengeFor(verifier)}}
}

func TestGoogleCallbackReplayHandsTheAppTheSameCode(t *testing.T) {
	g := newFakeGoogle(t, "replay-app@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	browser := noRedirects(&http.Client{})
	state := googleStart(t, h, g, browser, appStartQuery(verifier))

	first := googleCallback(t, h, browser, state, "test-code")
	// The repeat, as Chrome sent it at 17:04 on 31 Oct: same URL, a moment later.
	again := googleCallback(t, h, browser, state, "test-code")

	if first.Header.Get("Location") != again.Header.Get("Location") {
		t.Fatalf("repeat went to %s, first to %s", again.Header.Get("Location"), first.Header.Get("Location"))
	}
	if n := g.tokenCalls(); n != 1 {
		t.Fatalf("Google's token endpoint was called %d times, want 1", n)
	}
	if sessionCookieOf(again) != nil {
		t.Fatal("the repeat gave the system browser a session cookie")
	}
	code := appCodeOf(t, again)
	if n := h.pushCount(`SELECT count(*) FROM google_callback_replays WHERE app_nonce = $1 OR landing = $1`, code); n != 0 {
		t.Fatal("the raw app code is in the replay table")
	}

	// Still one redemption, whichever page fired the link.
	res, raw := h.exchange(code, verifier)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("exchange: %d %s", res.StatusCode, raw)
	}
	res, raw = h.exchange(code, verifier)
	wantCode(t, res, raw, http.StatusBadRequest, "code_used")

	// A repeat after the redemption still gets the same (now spent) code, not a fresh one.
	late := googleCallback(t, h, browser, state, "test-code")
	if appCodeOf(t, late) != code || g.tokenCalls() != 1 {
		t.Fatalf("late repeat minted a new code or asked Google again (%d calls)", g.tokenCalls())
	}
}

func TestGoogleCallbackConcurrentReplay(t *testing.T) {
	g := newFakeGoogle(t, "replay-race@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	browser := noRedirects(&http.Client{})
	state := googleStart(t, h, g, browser, appStartQuery(verifier))

	hold := make(chan struct{})
	g.mu.Lock()
	g.hold, g.entered = hold, make(chan struct{}, 4)
	g.mu.Unlock()

	var wg sync.WaitGroup
	locs := make([]string, 2)
	send := func(i int) {
		defer wg.Done()
		res, err := browser.Get(h.srv.URL + "/api/auth/google/callback?code=test-code&state=" + url.QueryEscape(state))
		if err != nil {
			t.Error(err)
			return
		}
		res.Body.Close()
		locs[i] = res.Header.Get("Location")
	}
	wg.Add(2)
	go send(0)
	<-g.entered // the first is at Google
	go send(1)
	time.Sleep(300 * time.Millisecond) // the second is waiting on it, not at Google
	close(hold)
	wg.Wait()

	if n := g.tokenCalls(); n != 1 {
		t.Fatalf("Google's token endpoint was called %d times, want 1", n)
	}
	if locs[0] == "" || locs[0] != locs[1] {
		t.Fatalf("concurrent callbacks went to %q and %q", locs[0], locs[1])
	}
	if res, raw := h.exchange(appCodeOf(t, &http.Response{Header: http.Header{"Location": {locs[1]}}}), verifier); res.StatusCode != http.StatusOK {
		t.Fatalf("exchange: %d %s", res.StatusCode, raw)
	}
}

func TestGoogleCallbackReplayExpires(t *testing.T) {
	g := newFakeGoogle(t, "replay-expiry@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	browser := noRedirects(&http.Client{})
	state := googleStart(t, h, g, browser, appStartQuery(verifier))
	code := appCodeOf(t, googleCallback(t, h, browser, state, "test-code"))

	if _, err := h.store.Pool().Exec(context.Background(),
		`UPDATE google_callback_replays SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	// Past the window the repeat is a new callback: Google is asked again (and in real life
	// refuses the spent code; the fake says yes, so a new code shows it really was asked).
	again := appCodeOf(t, googleCallback(t, h, browser, state, "test-code"))
	if g.tokenCalls() != 2 {
		t.Fatalf("token calls %d after expiry, want 2", g.tokenCalls())
	}
	if again == code {
		t.Fatal("an expired replay row was still answered from")
	}
}

func TestGoogleCallbackReplayNeedsTheSameState(t *testing.T) {
	g := newFakeGoogle(t, "replay-state@test.dev")
	h := newHarness(t, withGoogleOAuth)

	verifier := newVerifier(t)
	browser := noRedirects(&http.Client{})
	state := googleStart(t, h, g, browser, appStartQuery(verifier))
	code := appCodeOf(t, googleCallback(t, h, browser, state, "test-code"))

	// Somebody else's sign-in that happens to carry the same Google code string.
	other := googleStart(t, h, g, browser, appStartQuery(newVerifier(t)))
	otherCode := appCodeOf(t, googleCallback(t, h, browser, other, "test-code"))
	if otherCode == code || g.tokenCalls() != 2 {
		t.Fatalf("a different state was served the first result (%d token calls)", g.tokenCalls())
	}

	// And a forged state is refused as before, cache or no cache.
	res := googleCallback(t, h, browser, state+"x", "test-code")
	if back, _ := url.Parse(res.Header.Get("Location")); back.Query().Get("google") != "state" {
		t.Fatalf("forged state went to %s", res.Header.Get("Location"))
	}
}

func TestGoogleCallbackWebReplay(t *testing.T) {
	g := newFakeGoogle(t, "replay-web@test.dev")
	h := newHarness(t, withGoogleOAuth)
	newBrowser := func() *http.Client {
		jar, err := cookiejar.New(nil)
		if err != nil {
			t.Fatal(err)
		}
		return noRedirects(&http.Client{Jar: jar})
	}
	signedIn := func(c *http.Client) bool {
		res, err := c.Get(h.srv.URL + "/api/auth/me")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode == http.StatusOK
	}
	web := url.Values{"next": {"/"}}

	// The first response reached the browser: the repeat (a PWA window on the same cookie
	// jar) lands in the same place and is not handed a second session.
	b := newBrowser()
	state := googleStart(t, h, g, b, web)
	first := googleCallback(t, h, b, state, "test-code")
	again := googleCallback(t, h, b, state, "test-code")
	if first.Header.Get("Location") != again.Header.Get("Location") || g.tokenCalls() != 1 {
		t.Fatalf("repeat went to %s (first %s), %d token calls",
			again.Header.Get("Location"), first.Header.Get("Location"), g.tokenCalls())
	}
	if sessionCookieOf(first) == nil || sessionCookieOf(again) != nil {
		t.Fatal("want a session on the first response only")
	}
	if !signedIn(b) {
		t.Fatal("the browser is not signed in")
	}

	// The first response was lost (the tab that sent it closed): the repeat still carries
	// this state's cookie, so it is the same browser and gets the session.
	b = newBrowser()
	state = googleStart(t, h, g, b, web)
	origin, _ := url.Parse(h.srv.URL)
	var stateCookie *http.Cookie
	for _, c := range b.Jar.Cookies(origin) {
		if c.Name == "webcast_google" {
			stateCookie = c
		}
	}
	if stateCookie == nil {
		t.Fatal("start set no state cookie")
	}
	lost := googleCallback(t, h, noRedirects(&http.Client{}), state, "test-code", stateCookie)
	again = googleCallback(t, h, b, state, "test-code")
	if sessionCookieOf(again) == nil || !signedIn(b) {
		t.Fatal("the same browser's repeat was not signed in")
	}
	if again.Header.Get("Location") != lost.Header.Get("Location") || g.tokenCalls() != 2 {
		t.Fatalf("repeat went to %s (first %s), %d token calls",
			again.Header.Get("Location"), lost.Header.Get("Location"), g.tokenCalls())
	}

	// Anybody else with the URL (no state cookie, or another sign-in's) gets the redirect
	// and nothing else.
	stranger := newBrowser()
	googleStart(t, h, g, stranger, web) // a state cookie, but not this state's
	res := googleCallback(t, h, stranger, state, "test-code")
	if sessionCookieOf(res) != nil || signedIn(stranger) {
		t.Fatal("a repeat without the matching state cookie was signed in")
	}
	if res.Header.Get("Location") != lost.Header.Get("Location") || g.tokenCalls() != 2 {
		t.Fatalf("stranger's repeat went to %s, %d token calls", res.Header.Get("Location"), g.tokenCalls())
	}
}
