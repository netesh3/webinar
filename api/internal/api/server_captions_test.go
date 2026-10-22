package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* Server-side captions (server_captions.go, deploy/captions). The agent itself is Python and
 * tested there; these pin the API's half: the host switch dispatches and removes the agent,
 * the agent's endpoints refuse anything without the shared secret, and an accepted line is
 * stored and reaches the room as the very packet a browser caption is. */

const testCaptionsSecret = "captions-secret-captions-secret-0123456789"

func captionsConfig(c *config.Config) { c.CaptionsSecret = testCaptionsSecret }

// The fake's half of agentDispatcher: one dispatch per room, like lk.Client.DispatchAgent.
func (f *fakeRooms) DispatchAgent(_ context.Context, room, agentName, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dispatchErr != nil {
		return "", f.dispatchErr
	}
	if f.dispatches == nil {
		f.dispatches = map[string]string{}
	}
	f.dispatches[room] = agentName
	return "AD_" + room, nil
}

func (f *fakeRooms) StopAgent(_ context.Context, room, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.dispatches, room)
	return nil
}

func (f *fakeRooms) dispatched(room string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	name, ok := f.dispatches[room]
	return name, ok
}

// agentPost is the caption agent calling the API: no session, the secret in a header.
func (h *harness) agentPost(path, secret string, body any) (*http.Response, []byte) {
	h.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Captions-Secret", secret)
	}
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

func (h *harness) setServerCaptions(slug string, on bool) (*http.Response, types.Webinar, []byte) {
	h.t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/captions/server", types.ServerCaptionsRequest{On: on})
	var wb types.Webinar
	if res.StatusCode == http.StatusOK {
		h.decode(raw, &wb)
	}
	return res, wb, raw
}

func TestServerCaptionsToggleDispatchesAndRemovesTheAgent(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Caption Host", "srvcap-toggle@test.dev", true)
	wb := h.liveWebinar("Server captions toggle", nil)
	room := "webinar_" + wb.ID

	res, on, raw := h.setServerCaptions(wb.ID, true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("on: %d %s", res.StatusCode, raw)
	}
	if name, ok := h.rooms.dispatched(room); !ok || name != "webinar-captions" {
		t.Fatalf("dispatch = %q %v, want webinar-captions", name, ok)
	}
	// On turns captions on, but the browsers keep their own engine until the agent says it
	// has actually joined.
	if !on.Controls.CaptionsEnabled || on.Controls.ServerCaptions {
		t.Fatalf("controls after on = %+v, want captions on and serverCaptions still false", on.Controls)
	}

	// The agent reports itself live: now the browsers are told to stand down.
	if res, raw := h.agentPost("/api/internal/captions/status", testCaptionsSecret,
		map[string]string{"room": room, "state": "live"}); res.StatusCode != http.StatusOK {
		t.Fatalf("status live: %d %s", res.StatusCode, raw)
	}
	if meta := h.rooms.roomMeta(t, room); !meta.Controls.ServerCaptions {
		t.Fatalf("room metadata serverCaptions = false after the agent went live")
	}
	// Paused by its CPU guard: back to the browsers.
	h.agentPost("/api/internal/captions/status", testCaptionsSecret, map[string]string{"room": room, "state": "paused"})
	if meta := h.rooms.roomMeta(t, room); meta.Controls.ServerCaptions {
		t.Fatalf("serverCaptions still true while the agent is paused")
	}
	h.agentPost("/api/internal/captions/status", testCaptionsSecret, map[string]string{"room": room, "state": "live"})

	res, off, raw := h.setServerCaptions(wb.ID, false)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("off: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("dispatch still open after server captions were turned off")
	}
	if off.Controls.ServerCaptions || !off.Controls.CaptionsEnabled {
		t.Fatalf("controls after off = %+v, want local captions still on", off.Controls)
	}
	// A late "live" from an agent on its way out does not turn the room back over to it.
	h.agentPost("/api/internal/captions/status", testCaptionsSecret, map[string]string{"room": room, "state": "live"})
	if meta := h.rooms.roomMeta(t, room); meta.Controls.ServerCaptions {
		t.Fatal("a stale live report re-enabled server captions")
	}

	// Captions off through the ordinary control also removes the agent.
	h.setServerCaptions(wb.ID, true)
	off2 := false
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{CaptionsEnabled: &off2}); res.StatusCode != http.StatusOK {
		t.Fatalf("controls: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("dispatch still open after captions were switched off")
	}

	// And ending the session removes it too.
	h.setServerCaptions(wb.ID, true)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("dispatch still open after the session ended")
	}
	requested, err := h.store.ServerCaptionsRequested(context.Background(), wb.ID)
	if err != nil || requested {
		t.Fatalf("server captions still requested after end: %v %v", requested, err)
	}
}

func TestServerCaptionsUnavailableWithoutTheSecret(t *testing.T) {
	h := newHarness(t)
	h.signup("No Agent Host", "srvcap-none@test.dev", true)
	wb := h.liveWebinar("No server captions", nil)
	res, _, raw := h.setServerCaptions(wb.ID, true)
	if res.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(raw), "server_captions_unavailable") {
		t.Fatalf("on without CAPTIONS_SECRET: %d %s, want 503", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched("webinar_" + wb.ID); ok {
		t.Fatal("dispatched without a configured agent")
	}
	// The internal endpoints do not exist at all.
	if res, _ := h.agentPost("/api/internal/captions", testCaptionsSecret, map[string]string{"room": "webinar_" + wb.ID}); res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("internal captions mounted without a secret: %d", res.StatusCode)
	}
}

func TestServerCaptionsHostOnly(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Owner", "srvcap-owner@test.dev", true)
	wb := h.liveWebinar("Owner only", nil)
	h.logout()
	h.signup("Stranger", "srvcap-stranger@test.dev", true)
	if res, _, raw := h.setServerCaptions(wb.ID, true); res.StatusCode == http.StatusOK {
		t.Fatalf("a different host turned on server captions: %s", raw)
	}
}

func TestInternalCaptionAuth(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Auth Host", "srvcap-auth@test.dev", true)
	wb := h.liveWebinar("Caption auth", nil)
	body := map[string]any{"room": "webinar_" + wb.ID, "identity": "user_x", "text": "hello"}
	for _, secret := range []string{"", "wrong", testCaptionsSecret + "x", testCaptionsSecret[:20]} {
		for _, path := range []string{"/api/internal/captions", "/api/internal/captions/status", "/api/internal/transcripts"} {
			if res, raw := h.agentPost(path, secret, body); res.StatusCode != http.StatusUnauthorized {
				t.Fatalf("%s with secret %q: %d %s, want 401", path, secret, res.StatusCode, raw)
			}
		}
	}
	// The right secret gets past auth (and is refused for a different reason: captions are off).
	if res, raw := h.agentPost("/api/internal/captions", testCaptionsSecret, body); res.StatusCode != http.StatusConflict {
		t.Fatalf("caption with captions off: %d %s, want 409", res.StatusCode, raw)
	}
}

func TestInternalCaptionStoresAndFansOutLikeABrowserCaption(t *testing.T) {
	h := newHarness(t, captionsConfig, edgeConfig)
	host := edgeHost(t, h, "srvcap-fanout@test.dev")
	wb := edgeWebinar(h, "Caption fan-out")
	room := "webinar_" + wb.ID
	speaker := "user_" + host.ID
	h.rooms.mu.Lock()
	h.rooms.roster = append(h.rooms.roster, types.LiveParticipant{Identity: speaker, Name: "Asha Rao", Role: types.RoleHost})
	h.rooms.mu.Unlock()

	// An edge viewer, watching the feed: not in the LiveKit room at all.
	viewer := h.registerAsGuest(wb.ID, "srvcap-viewer@test.dev")
	_, vj, _ := h.joinAsGuestKey(wb.ID, viewer.JoinKey)
	events, res, cancel := h.openEvents(wb.ID, vj.EventsToken)
	defer cancel()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("events: %d", res.StatusCode)
	}
	waitFor(t, events, 3*time.Second, func(e sseEvent) bool { return e.kind == "meta" })
	syncStream(t, h, wb.ID, events)

	if res, _, raw := h.setServerCaptions(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("on: %d %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	h.rooms.sent = nil
	h.rooms.mu.Unlock()

	line := "Namaste everyone, aaj hum pricing ke baare mein baat karenge"
	if res, raw := h.agentPost("/api/internal/captions", testCaptionsSecret, map[string]any{
		"room": room, "identity": speaker, "text": "  " + line + "  ", "startedAt": time.Now().UnixMilli(),
		"language": "hi", // a field this API does not know is ignored, not refused
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("caption: %d %s", res.StatusCode, raw)
	}

	// Stored where a browser caption goes, so the transcript download has it.
	text, err := h.store.CaptionTranscript(context.Background(), wb.ID)
	if err != nil || !strings.Contains(text, line) {
		t.Fatalf("transcript = %q (%v), want the line", text, err)
	}

	// The WebRTC room gets one packet, to everyone, in the browser caption's shape.
	h.rooms.mu.Lock()
	sent := append([]sentPacket(nil), h.rooms.sent...)
	h.rooms.mu.Unlock()
	if len(sent) != 1 || sent[0].room != room || sent[0].to != nil {
		t.Fatalf("packets = %+v, want one broadcast to %s", sent, room)
	}
	var pkt struct {
		Kind string `json:"kind"`
		From struct {
			Identity string     `json:"identity"`
			Name     string     `json:"name"`
			Role     types.Role `json:"role"`
		} `json:"from"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(sent[0].data, &pkt); err != nil {
		t.Fatal(err)
	}
	if pkt.Kind != "caption" || pkt.Text != line || pkt.From.Identity != speaker ||
		pkt.From.Name != "Asha Rao" || pkt.From.Role != types.RoleHost {
		t.Fatalf("packet = %+v, want a caption from Asha Rao", pkt)
	}

	// And the edge viewer gets the same packet over SSE.
	waitFor(t, events, 3*time.Second, func(e sseEvent) bool {
		return e.kind == "packet" && strings.Contains(e.data, `"caption"`) && strings.Contains(e.data, "pricing ke baare")
	})

	// Off: the next line is refused, and nothing reaches the room.
	h.setServerCaptions(wb.ID, false)
	if res, raw := h.agentPost("/api/internal/captions", testCaptionsSecret, map[string]any{
		"room": room, "identity": speaker, "text": "late line",
	}); res.StatusCode != http.StatusConflict {
		t.Fatalf("caption after off: %d %s, want 409", res.StatusCode, raw)
	}
}

func TestInternalTranscriptIsStored(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Transcript Host", "srvcap-transcript@test.dev", true)
	wb := h.liveWebinar("Transcript", nil)
	room := "webinar_" + wb.ID
	segments := []map[string]any{
		{"identity": "user_a", "name": "Asha", "start": 1000, "end": 4000, "text": "Welcome, sab log."},
		{"identity": "user_b", "name": "Ravi", "start": 4200, "end": 6000, "text": "Thank you."},
		{"identity": "user_b", "start": 7000, "end": 7100, "text": "   "}, // empty: dropped
	}
	res, raw := h.agentPost("/api/internal/transcripts", testCaptionsSecret, map[string]any{
		"room": room, "model": "large-v3-turbo", "segments": segments,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("transcript: %d %s", res.StatusCode, raw)
	}
	model, got, err := h.store.LatestSessionTranscript(context.Background(), wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	if model != "large-v3-turbo" || len(got) != 2 || got[0].Name != "Asha" || got[1].Start != 4200 || got[1].Text != "Thank you." {
		t.Fatalf("stored = %s %+v", model, got)
	}

	if res, raw := h.agentPost("/api/internal/transcripts", testCaptionsSecret, map[string]any{
		"room": "webinar_nope", "model": "large-v3-turbo", "segments": segments,
	}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown room: %d %s, want 404", res.StatusCode, raw)
	}
}
