package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Streaming out, Google Drive and file exports are on plans (migrations/0183, 2 Nov 2026):
 * without the switch nothing starts, nothing is sent to YouTube or the egress, and no file
 * is handed over. Each test counts the calls a fake paid client receives. */

// No YouTube API call, connect, RTMP key or egress push for a host without stream_out.
func TestStreamOutNeverStartsWithoutTheSwitch(t *testing.T) {
	ctx := context.Background()
	var ytCalls atomic.Int32
	yt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ytCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "a", "items": []any{}})
	}))
	t.Cleanup(yt.Close)
	h := newHarness(t, func(c *config.Config) {
		c.GoogleClientID = "cid"
		c.GoogleClientSecret = "secret"
		c.YouTubeAPIURL = yt.URL + "/youtube/v3"
		c.YouTubeTokenURL = yt.URL + "/token"
	})
	host := h.signup("No Stream Host", "no-stream@test.dev", true)
	withoutExtras(t, h, host.ID)
	if err := h.store.SetUserYouTube(ctx, host.ID, "refresh-1", "UCc", "Chan", "stream-1"); err != nil {
		t.Fatal(err)
	}
	wb := h.newWebinar("No streaming", func(in *types.WebinarInput) { in.Options.Multistream = true })

	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPatch, "/api/host/webinars/" + wb.ID + "/stream", types.SetStreamRequest{ViaYouTube: true}},
		{http.MethodPatch, "/api/host/webinars/" + wb.ID + "/stream", types.SetStreamRequest{StreamKey: "k", WatchURL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}},
		{http.MethodGet, "/api/host/youtube/connect", nil},
		{http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: liStreamURL, StreamKey: liKey}},
	} {
		res, raw := h.do(c.method, c.path, c.body)
		if res.StatusCode != http.StatusForbidden || !strings.Contains(string(raw), "Professional") {
			t.Errorf("%s %s without stream_out: %d %s, want 403 naming the plan", c.method, c.path, res.StatusCode, raw)
		}
	}
	// Going live with "Stream to YouTube" on creates no broadcast and pushes nothing.
	h.goLive(wb.ID)
	time.Sleep(100 * time.Millisecond)
	if n := ytCalls.Load(); n != 0 {
		t.Fatalf("the YouTube API was called %d times for a host without stream_out", n)
	}
	if n := startCount(h, "webinar_"+wb.ID); n != 0 {
		t.Fatalf("%d egress starts for a host without stream_out", n)
	}

	// An admin's override counts: the same call now reaches YouTube.
	forceFeature(t, h, host.ID, types.FeatureStreamOut, true)
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{ViaYouTube: true})
	if res.StatusCode == http.StatusForbidden {
		t.Fatalf("with the override: %d %s", res.StatusCode, raw)
	}
	if ytCalls.Load() == 0 {
		t.Fatal("with the override YouTube was never asked")
	}
}

// A saved LinkedIn key is not pushed by the compositor once the host has no stream_out.
func TestCompositorGetsNoDestinationsWithoutStreamOut(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "no-dest@test.dev")
	if res, raw := h.do(http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: liStreamURL, StreamKey: liKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("save linkedin: %d %s", res.StatusCode, raw)
	}
	forceFeature(t, h, h.me().ID, types.FeatureStreamOut, false)
	wb := edgeWebinar(h, "Origin only")
	origin := "rtmp://origin.test/live/" + wb.ID
	waitForCalls(t, h, origin)
	time.Sleep(150 * time.Millisecond)
	h.rooms.mu.Lock()
	calls := strings.Join(h.rooms.egressCalls, "\n") + strings.Join(h.rooms.streamAdds, "\n")
	h.rooms.mu.Unlock()
	if strings.Contains(calls, liIngest) {
		t.Fatalf("LinkedIn was pushed for a host without stream_out:\n%s", calls)
	}
}

// Every export route answers 403 without csv_export, and the file with it.
func TestEveryExportNeedsCSVExport(t *testing.T) {
	h := newHarness(t)
	host := h.signup("Export Host", "exports@test.dev", true)
	wb := h.newWebinar("Exports", nil)
	routes := []string{
		"/registrants.csv", "/report.csv", "/attendees.csv", "/engagement.csv", "/transcript.txt", "/chat?format=csv",
	}
	withoutExtras(t, h, host.ID)
	for _, p := range routes {
		res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+p, nil)
		if res.StatusCode != http.StatusForbidden || !strings.Contains(string(raw), "Professional") {
			t.Errorf("%s without csv_export: %d %s, want 403", p, res.StatusCode, raw)
		}
	}
	// What the screen shows is not an export: the chat as JSON stays.
	if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/chat", nil); res.StatusCode != http.StatusOK {
		t.Errorf("chat on screen: %d %s", res.StatusCode, raw)
	}
	if _, err := h.store.SetUserPlan(context.Background(), host.ID, types.PlanProfessional); err != nil {
		t.Fatal(err)
	}
	for _, p := range routes {
		if res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+p, nil); res.StatusCode == http.StatusForbidden {
			t.Errorf("%s on Professional: %d %s", p, res.StatusCode, raw)
		}
	}
}

// The apps' Drive and YouTube hand-offs mint nothing without the switch.
func TestAppHandOffsNeedTheirSwitch(t *testing.T) {
	_, cfg := withAppConnect(t)
	h := newHarness(t, cfg)
	host := h.signup("Hand-off Host", "handoff-gates@test.dev", true)
	withoutExtras(t, h, host.ID)
	for _, provider := range []string{"drive", "youtube"} {
		res, raw := h.do(http.MethodPost, "/api/host/integrations/"+provider+"/app-ticket", types.AppConnectTicketRequest{App: "android"})
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("%s ticket without its switch: %d %s, want 403", provider, res.StatusCode, raw)
		}
	}
	forceFeature(t, h, host.ID, types.FeatureGoogleDrive, true)
	if res, raw := h.do(http.MethodPost, "/api/host/integrations/drive/app-ticket", types.AppConnectTicketRequest{App: "android"}); res.StatusCode != http.StatusOK {
		t.Fatalf("drive ticket with the override: %d %s", res.StatusCode, raw)
	}
}
