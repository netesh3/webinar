package yt

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthCodeURLAsksForOfflineAccess(t *testing.T) {
	c := New("cid", "secret")
	u := c.AuthCodeURL("http://localhost:3000/api/host/youtube/callback", "state-1")
	if !strings.Contains(u, "access_type=offline") || !strings.Contains(u, "prompt=consent") {
		t.Fatalf("url = %s, want offline + consent so Google issues a refresh token", u)
	}
	if !strings.Contains(u, "client_id=cid") {
		t.Errorf("missing client id: %s", u)
	}
}

func TestExchangeAndStartLive(t *testing.T) {
	var streams, broadcasts int
	var deleted []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			_ = r.ParseForm()
			refresh := "refresh-from-google"
			if r.Form.Get("grant_type") == "refresh_token" {
				refresh = r.Form.Get("refresh_token")
			}
			writeJSON(w, map[string]string{
				"access_token":  "access-1",
				"refresh_token": refresh,
			})
		case strings.HasSuffix(r.URL.Path, "/channels"):
			writeJSON(w, map[string]any{
				"items": []map[string]any{{
					"id":      "UCchannel",
					"snippet": map[string]string{"title": "Host Channel"},
				}},
			})
		case strings.HasSuffix(r.URL.Path, "/liveStreams") && r.Method == http.MethodPost:
			streams++
			writeJSON(w, map[string]any{
				"id": "stream-1",
				"cdn": map[string]any{
					// Both addresses, as YouTube sends them. The RTMPS one is a
					// different host, not the same one with another scheme.
					"ingestionInfo": map[string]string{
						"ingestionAddress":      "rtmp://a.rtmp.youtube.com/live2",
						"rtmpsIngestionAddress": "rtmps://a.rtmps.youtube.com/live2",
						"streamName":            "abcd-efgh-ijkl-mnop",
					},
				},
			})
		case strings.HasSuffix(r.URL.Path, "/liveStreams") && r.Method == http.MethodGet:
			writeJSON(w, map[string]any{"items": []any{}})
		/* The sweep for broadcasts still holding the reusable stream. One
		 * upcoming broadcast is bound to it and one is bound to somebody
		 * else's stream, so the test pins that only the first is cleared. */
		case strings.HasSuffix(r.URL.Path, "/liveBroadcasts") && r.Method == http.MethodGet:
			if r.URL.Query().Get("broadcastStatus") != "upcoming" {
				writeJSON(w, map[string]any{"items": []any{}})
				return
			}
			writeJSON(w, map[string]any{"items": []map[string]any{
				{"id": "stuck-on-our-stream",
					"contentDetails": map[string]string{"boundStreamId": "stream-1"}},
				{"id": "someone-elses",
					"contentDetails": map[string]string{"boundStreamId": "stream-9"}},
			}})
		case strings.HasSuffix(r.URL.Path, "/liveBroadcasts") && r.Method == http.MethodDelete:
			deleted = append(deleted, r.URL.Query().Get("id"))
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/liveBroadcasts") && r.Method == http.MethodPost:
			broadcasts++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			status, _ := body["status"].(map[string]any)
			if status["privacyStatus"] != "unlisted" {
				t.Errorf("privacy = %v, want unlisted", status["privacyStatus"])
			}
			/* A broadcast with a monitor stream stops at "testing" when the
			 * encoder connects and never reaches the watch page on its own, so
			 * asking for one here would ship a live that looks perfect from the
			 * ingest side and plays nothing. */
			details, _ := body["contentDetails"].(map[string]any)
			if details["enableAutoStart"] != true {
				t.Errorf("enableAutoStart = %v, want true", details["enableAutoStart"])
			}
			monitor, _ := details["monitorStream"].(map[string]any)
			if monitor["enableMonitorStream"] != false {
				t.Errorf("enableMonitorStream = %v, want false", monitor["enableMonitorStream"])
			}
			writeJSON(w, map[string]string{"id": "dQw4w9WgXcQ"})
		case strings.HasSuffix(r.URL.Path, "/liveBroadcasts/bind"):
			writeJSON(w, map[string]string{"id": r.URL.Query().Get("id")})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	c := New("cid", "secret")
	c.TokenURL = srv.URL + "/token"
	c.API = srv.URL + "/youtube/v3"
	c.HTTP = srv.Client()

	tok, ch, err := c.Exchange(context.Background(), "http://localhost/callback", "code-1")
	if err != nil {
		t.Fatal(err)
	}
	if tok.RefreshToken != "refresh-from-google" || ch.Title != "Host Channel" {
		t.Fatalf("tok=%+v ch=%+v", tok, ch)
	}

	live, _, err := c.StartLive(context.Background(), tok.RefreshToken, "Q3 all-hands", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if live.WatchURL != "https://www.youtube.com/watch?v=dQw4w9WgXcQ" {
		t.Errorf("watch = %q", live.WatchURL)
	}
	if !strings.Contains(live.IngestURL, "abcd-efgh-ijkl-mnop") {
		t.Errorf("ingest = %q, want the stream key", live.IngestURL)
	}
	/* The address YouTube nominated for RTMPS, not one derived from the plain
	 * address. a.rtmp.youtube.com does not answer on 443, so getting this
	 * wrong means the encoder never connects and the live waits forever. */
	if live.IngestURL != "rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop" {
		t.Errorf("ingest = %q, want YouTube's rtmpsIngestionAddress with the key", live.IngestURL)
	}
	if streams != 1 || broadcasts != 1 {
		t.Errorf("streams=%d broadcasts=%d", streams, broadcasts)
	}
	/* The leftover broadcast on our stream is cleared, and only that one.
	 *
	 * YouTube assigns a stream to one unfinished broadcast at a time, so a
	 * session that ended without completing blocks every session after it —
	 * the new live reports "Stream key is currently assigned" and waits
	 * forever while the encoder happily sends. Deleting somebody else's
	 * broadcast to fix that would be a far worse bug than the one it fixes. */
	if len(deleted) != 1 || deleted[0] != "stuck-on-our-stream" {
		t.Errorf("deleted = %v, want just the broadcast holding our stream", deleted)
	}
}

func TestLiveDisabledIsAFriendlyError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/token") {
			writeJSON(w, map[string]string{"access_token": "a", "refresh_token": "r"})
			return
		}
		w.WriteHeader(http.StatusForbidden)
		writeJSON(w, map[string]any{
			"error": map[string]any{
				"message": "The user has not enabled live streaming",
				"errors":  []map[string]string{{"reason": "liveStreamingNotEnabled"}},
			},
		})
	}))
	t.Cleanup(srv.Close)

	c := New("cid", "secret")
	c.TokenURL = srv.URL + "/token"
	c.API = srv.URL
	c.HTTP = srv.Client()

	_, _, err := c.StartLive(context.Background(), "refresh", "Talk", PrivacyUnlisted, "")
	if err != ErrLiveDisabled {
		t.Fatalf("err = %v, want ErrLiveDisabled", err)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func TestEnabled(t *testing.T) {
	if New("", "s").Enabled() || New("id", "").Enabled() {
		t.Fatal("empty credentials must not enable YouTube OAuth")
	}
	if !New("id", "s").Enabled() {
		t.Fatal("want enabled")
	}
}
