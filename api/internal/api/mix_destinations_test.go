package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/types"
)

// waitForCalls polls the fake until its calls contain want, or fails.
func waitForCalls(t *testing.T, h *harness, want string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		calls := h.rooms.pushedURLs()
		if strings.Contains(calls, want) {
			return calls
		}
		if time.Now().After(deadline) {
			t.Fatalf("never saw %q; calls:\n%s", want, calls)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func startCount(h *harness, room string) int {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	n := 0
	for _, c := range h.rooms.egressCalls {
		if strings.HasPrefix(c, room+":") {
			n++
		}
	}
	return n
}

/* A refused stream key costs that platform, not the mix.
 *
 * Production, 2026-10-18: one bad destination in the list an egress was started with failed
 * the whole egress, every thirty seconds, and the audience watched black. Now the compositor
 * starts on our origin alone and each platform is attached afterwards. */
func TestRefusedDestinationOnlyCostsThatPlatform(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "refused-dest@test.dev")
	res, raw := h.do(http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: liStreamURL, StreamKey: liKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("save linkedin: %d %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	h.rooms.refuseStream = map[string]bool{liIngest: true}
	h.rooms.mu.Unlock()

	wb := edgeWebinar(h, "Refused destination")
	origin := "rtmp://origin.test/live/" + wb.ID
	waitForCalls(t, h, origin)
	// Give the attach a moment to run after the start.
	time.Sleep(100 * time.Millisecond)

	h.rooms.mu.Lock()
	calls := strings.Join(h.rooms.egressCalls, "\n")
	adds := strings.Join(h.rooms.streamAdds, "\n")
	h.rooms.mu.Unlock()
	if !strings.Contains(calls, "webinar_"+wb.ID+":"+origin) {
		t.Fatalf("the mix should start on our origin; calls:\n%s", calls)
	}
	if strings.Contains(calls, "extra:") {
		t.Fatalf("the mix was started with platform URLs in it; calls:\n%s", calls)
	}
	if strings.Contains(adds, liIngest) {
		t.Fatalf("a refused destination was attached anyway: %s", adds)
	}

	var li types.WebinarStreamDestination
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/linkedin", nil)
	h.decode(raw, &li)
	if res.StatusCode != http.StatusOK || !li.Refused || li.Streaming {
		t.Fatalf("linkedin after refusal: %d %+v", res.StatusCode, li)
	}

	// Pause and resume is the host's "try again": it gets a fresh attempt.
	h.rooms.mu.Lock()
	h.rooms.refuseStream = nil
	h.rooms.liveEgress = []*livekit.EgressInfo{{
		EgressId: api.ActiveBroadcast(wb.ID), Status: livekit.EgressStatus_EGRESS_ACTIVE,
		StreamResults: []*livekit.StreamInfo{{Url: origin}},
	}}
	h.rooms.mu.Unlock()
	for _, paused := range []bool{true, false} {
		res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarStreamPausedRequest{Paused: paused})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("pause=%v: %d %s", paused, res.StatusCode, raw)
		}
	}
	waitForCalls(t, h, liIngest)
	li = types.WebinarStreamDestination{}
	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/linkedin", nil)
	h.decode(raw, &li)
	if li.Refused || !li.Streaming {
		t.Fatalf("linkedin after resume: %+v", li)
	}
}

/* A room that only streams out (no origin) starts on its destination; if that destination
 * refuses the stream at start, it is retired, and the mix is not restarted against it every
 * thirty seconds — the old loop. */
func TestPublishRejectionAtStartRetiresTheDestination(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach", "publish-rejected@test.dev", true)
	wb := h.liveWebinar("Bad pasted key", nil)
	defer api.SetMixQuickRestart(10 * time.Millisecond)()

	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		StreamKey: "abcd-efgh-ijkl-mnop", WatchURL: "https://youtu.be/dQw4w9WgXcQ",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("set stream: %d %s", res.StatusCode, raw)
	}
	room := "webinar_" + wb.ID
	waitForCalls(t, h, "abcd-efgh-ijkl-mnop")
	id := api.ActiveBroadcast(wb.ID)
	if id == "" || id == "starting" {
		t.Fatalf("no broadcast recorded: %q", id)
	}

	api.OnBroadcastEgressEnded(h.server, context.Background(), &livekit.EgressInfo{
		EgressId: id, RoomName: room, Status: livekit.EgressStatus_EGRESS_FAILED,
		Error: `Failed to connect: 'publish' cmd failed: onStatus: { "code": "NetStream.Publish.Failed", "description": "Publish Rejected: Invalid URL" }`,
	})
	time.Sleep(200 * time.Millisecond)
	if n := startCount(h, room); n != 1 {
		t.Fatalf("the mix was restarted %d times against a refused destination", n-1)
	}

	var got types.Webinar
	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/", nil)
	h.decode(raw, &got)
	if !got.StreamRefused {
		t.Fatalf("the host should be told the destination refused the stream: %+v", got)
	}
}

/* A mix that ends while the webinar is live comes back within seconds, from the egress
 * webhook, rather than at the sweeper's next pass. */
func TestLostMixIsPutBackQuickly(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "quick-restart@test.dev")
	defer api.SetMixQuickRestart(10 * time.Millisecond)()
	wb := edgeWebinar(h, "Quick restart")
	room := "webinar_" + wb.ID
	waitForCalls(t, h, "rtmp://origin.test/live/"+wb.ID)
	deadline := time.Now().Add(2 * time.Second)
	for api.ActiveBroadcast(wb.ID) == "starting" || api.ActiveBroadcast(wb.ID) == "" {
		if time.Now().After(deadline) {
			t.Fatal("broadcast never recorded")
		}
		time.Sleep(10 * time.Millisecond)
	}
	before := startCount(h, room)

	api.OnBroadcastEgressEnded(h.server, context.Background(), &livekit.EgressInfo{
		EgressId: api.ActiveBroadcast(wb.ID), RoomName: room,
		Status: livekit.EgressStatus_EGRESS_COMPLETE, Details: "End reason: Source closed",
	})
	deadline = time.Now().Add(2 * time.Second)
	for startCount(h, room) == before {
		if time.Now().After(deadline) {
			t.Fatal("the mix was not put back after it ended")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

/* An edge audience is not in the LiveKit room, so the room must outlive a host's refresh:
 * the server default closes it twenty seconds after the last participant, which ended the mix. */
func TestEdgeRoomOutlivesAHostRefresh(t *testing.T) {
	h := newHarness(t, edgeConfig)
	edgeHost(t, h, "departure@test.dev")
	edge := edgeWebinar(h, "Edge departure")
	// Both on the air at once to compare them, which POST /start no longer allows one
	// host: the standard one goes live straight in the store.
	plain := h.newWebinar("Standard departure", nil)
	h.goLive(plain.ID)
	for _, slug := range []string{edge.ID, plain.ID} {
		res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/join", types.JoinRequest{})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("host join %s: %d %s", slug, res.StatusCode, raw)
		}
	}
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	if got := h.rooms.departures["webinar_"+edge.ID]; got < 120 {
		t.Fatalf("edge room departure timeout = %d, want minutes", got)
	}
	if got := h.rooms.departures["webinar_"+plain.ID]; got != 0 {
		t.Fatalf("standard room departure timeout = %d, want the server default (0)", got)
	}
}
