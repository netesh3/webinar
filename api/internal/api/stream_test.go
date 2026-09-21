package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
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
