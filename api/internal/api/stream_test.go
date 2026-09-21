package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func TestSetStreamStoresWatchURLAndHidesTheKey(t *testing.T) {
	h := newHarness(t)
	h.signup("Streamer", "streamer@test.dev", true)
	wb := h.newWebinar("Going live on YouTube", nil)

	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		StreamKey: "abcd-efgh-ijkl-mnop",
		WatchURL:  "https://youtu.be/dQw4w9WgXcQ",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("set stream: status %d body %s", res.StatusCode, raw)
	}
	var got types.Webinar
	h.decode(raw, &got)
	if !got.StreamConfigured {
		t.Fatal("want streamConfigured after a key is saved")
	}
	if got.StreamWatchURL != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Errorf("watch = %q", got.StreamWatchURL)
	}

	ingest, on, err := h.store.WebinarStreamIngest(context.Background(), wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ingest == "" || ingest == got.StreamWatchURL {
		t.Errorf("ingest = %q, want the RTMP URL with the key, never the watch link", ingest)
	}
	if !on {
		t.Error("want the stream pushing after a key is saved")
	}
	saved := ingest

	res, raw = h.do(http.MethodGet, "/api/webinars/"+wb.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public get: status %d body %s", res.StatusCode, raw)
	}
	var pub types.Webinar
	h.decode(raw, &pub)
	if pub.StreamWatchURL != "" || pub.StreamConfigured {
		t.Errorf("public webinar leaked stream fields: watch=%q configured=%v",
			pub.StreamWatchURL, pub.StreamConfigured)
	}

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		Off: true,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("clear stream: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &got)
	if got.StreamConfigured {
		t.Errorf("after off: still configured")
	}
	if got.StreamWatchURL != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Errorf("after off: watch = %q, want the recordings-tab link kept", got.StreamWatchURL)
	}
	if !got.StreamKeySaved {
		t.Error("after off: want the key still on file so Go live does not ask for it again")
	}

	/* Go live again with no key pasted. Stopping and starting is the ordinary
	 * thing to do in a session, and making the host fetch the key out of
	 * YouTube Studio a second time is not an acceptable answer to it. */
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		WatchURL: "https://youtu.be/dQw4w9WgXcQ",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("restart stream: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &got)
	if !got.StreamConfigured {
		t.Error("restart: want streamConfigured again without a pasted key")
	}
	again, on, err := h.store.WebinarStreamIngest(context.Background(), wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	if again != saved || !on {
		t.Errorf("restart: ingest = %q on = %v, want the saved key pushing again", again, on)
	}

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		Off:       true,
		DropWatch: true,
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("drop watch: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &got)
	if got.StreamWatchURL != "" {
		t.Errorf("after dropWatch: watch = %q", got.StreamWatchURL)
	}
	// Turning the option off on the schedule form means no YouTube on this
	// webinar at all, so the key goes with it.
	if got.StreamKeySaved {
		t.Error("after dropWatch: want the key forgotten too")
	}
}

func TestSetStreamRejectsAMissingKeyAndANonYouTubeLink(t *testing.T) {
	h := newHarness(t)
	h.signup("Streamer", "streamer2@test.dev", true)
	wb := h.newWebinar("No key yet", nil)

	res, _ := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		WatchURL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("missing key: status %d, want 422", res.StatusCode)
	}

	res, _ = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		StreamKey: "abcd-efgh-ijkl-mnop",
		WatchURL:  "https://vimeo.com/123",
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("vimeo watch: status %d, want 422", res.StatusCode)
	}
}

func TestViaYouTubeWithoutAConnectedChannel(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		c.GoogleClientID = "cid"
		c.GoogleClientSecret = "secret"
	})
	h.signup("Streamer", "yt-oauth@test.dev", true)
	wb := h.newWebinar("OAuth live", nil)

	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		ViaYouTube: true,
	})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("via youtube: status %d body %s, want 422", res.StatusCode, raw)
	}

	req, err := http.NewRequest(http.MethodGet, h.srv.URL+"/api/host/youtube/connect?return=/account", nil)
	if err != nil {
		t.Fatal(err)
	}
	noFollow := &http.Client{
		Jar: h.client.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	res, err = noFollow.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("connect: status %d, want 302 to Google", res.StatusCode)
	}
	loc := res.Header.Get("Location")
	if !strings.Contains(loc, "accounts.google.com") || !strings.Contains(loc, "access_type=offline") {
		t.Errorf("connect location = %s", loc)
	}
}

func TestYouTubeConnectWithoutSecret(t *testing.T) {
	h := newHarness(t)
	h.signup("Streamer", "no-secret@test.dev", true)
	res, _ := h.do(http.MethodGet, "/api/host/youtube/connect", nil)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("connect unset: status %d, want 503", res.StatusCode)
	}
}

/* Ending a webinar must end the broadcast, and must do it in that order.
 *
 * The push has to be down before YouTube is asked to finish: a broadcast whose
 * encoder is still connected refuses to complete, and that refusal is silent
 * here because finishing is best-effort. Getting the order backwards left the
 * broadcast live in Studio after the webinar was over, and left it holding the
 * channel's one reusable stream, which then blocked the next session from going
 * live at all.
 *
 * So the fake reads the webinar back as the transition arrives, and the test
 * asserts on what it saw rather than merely that YouTube was called. The broken
 * ordering called YouTube too, just too early, and every weaker assertion
 * passes on it.
 */
func TestEndingAWebinarEndsTheBroadcastAfterTheStreamIsDown(t *testing.T) {
	ctx := context.Background()

	var (
		slug      string
		completed []string
		pushUp    bool
		st        *store.Store
	)
	yt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/liveBroadcasts/transition") {
			_, on, _ := st.WebinarStreamIngest(ctx, slug)
			pushUp = on
			completed = append(completed, r.URL.Query().Get("id"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "a", "refresh_token": "r", "items": []any{},
		})
	}))
	t.Cleanup(yt.Close)

	h := newHarness(t, func(c *config.Config) {
		c.GoogleClientID = "cid"
		c.GoogleClientSecret = "secret"
		c.YouTubeAPIURL = yt.URL + "/youtube/v3"
		c.YouTubeTokenURL = yt.URL + "/token"
	})
	st = h.store

	host := h.signup("Streamer", "yt-end@test.dev", true)
	wb := h.newWebinar("Ends on its own", nil)
	slug = wb.ID

	if err := st.SetUserYouTube(ctx, host.ID, "refresh-1", "UCc", "Chan", "stream-1"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetWebinarStream(ctx, slug,
		"rtmps://a.rtmps.youtube.com/live2/key", "https://youtu.be/vid", "bcast-1"); err != nil {
		t.Fatal(err)
	}
	h.goLive(slug)

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/end", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}

	if len(completed) != 1 || completed[0] != "bcast-1" {
		t.Fatalf("completed = %v, want the webinar's broadcast ended exactly once", completed)
	}
	if pushUp {
		t.Error("YouTube was asked to end the broadcast while the push was still up")
	}
}
