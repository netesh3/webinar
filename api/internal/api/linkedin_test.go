package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/types"
)

const (
	liStreamURL = "rtmps://1a2b3c.channel.media.azure.net:2935/live/abc123"
	liKey       = "SECRETKEY99"
	liIngest    = liStreamURL + "/" + liKey
)

func linkedinCard(t *testing.T, h *harness, raw []byte) types.IntegrationCard {
	t.Helper()
	var list types.IntegrationsResponse
	h.decode(raw, &list)
	for _, c := range list.Integrations {
		if c.ID == "linkedin" {
			return c
		}
	}
	t.Fatalf("no linkedin card in %s", raw)
	return types.IntegrationCard{}
}

func TestLinkedInSaveShowsConnectedAndNeverEchoesTheKey(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach", "coach-li@test.dev", true)

	res, raw := h.do(http.MethodGet, "/api/host/integrations", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: %d %s", res.StatusCode, raw)
	}
	card := linkedinCard(t, h, raw)
	if card.Status != types.IntegrationStatusOff || len(card.Actions) == 0 || card.Actions[0].Kind != types.IntegrationActionStreamKey {
		t.Fatalf("before setup: %+v", card)
	}

	res, raw = h.do(http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: "https://www.linkedin.com/live", StreamKey: liKey})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "streamUrl") {
		t.Fatalf("bad url: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: liStreamURL})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "streamKey") {
		t.Fatalf("missing key: %d %s", res.StatusCode, raw)
	}

	res, raw = h.do(http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: liStreamURL, StreamKey: liKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("save: %d %s", res.StatusCode, raw)
	}
	if strings.Contains(string(raw), liKey) {
		t.Fatalf("response echoed the stream key: %s", raw)
	}
	card = linkedinCard(t, h, raw)
	if card.Status != types.IntegrationStatusConnected || !strings.Contains(card.Who, "key ending EY99") {
		t.Fatalf("after save: %+v", card)
	}

	res, raw = h.do(http.MethodDelete, "/api/host/integrations/linkedin", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("remove: %d %s", res.StatusCode, raw)
	}
	if card = linkedinCard(t, h, raw); card.Status != types.IntegrationStatusOff {
		t.Fatalf("after remove: %+v", card)
	}
}

/* The point of the feature: with LinkedIn saved, going live pushes to it, next
 * to YouTube, from one compositor — and pausing in the room takes it off that
 * compositor without touching YouTube. */
func TestLinkedInStreamsWithYouTubeAndPausesPerRoom(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach", "coach-li2@test.dev", true)
	wb := h.newWebinar("Live on LinkedIn too", nil)

	res, raw := h.do(http.MethodPut, "/api/host/integrations/linkedin", types.SaveStreamKeyRequest{StreamURL: liStreamURL, StreamKey: liKey})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("save: %d %s", res.StatusCode, raw)
	}

	// Not live yet: configured, not streaming.
	var li types.WebinarLinkedIn
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/linkedin", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get: %d %s", res.StatusCode, raw)
	}
	h.decode(raw, &li)
	if !li.Configured || li.Streaming || li.Paused {
		t.Fatalf("before live: %+v", li)
	}

	h.goLive(wb.ID)
	// YouTube from the room: nothing is encoding yet, so this starts the mix,
	// and the mix has to carry LinkedIn as well.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		StreamKey: "abcd-efgh-ijkl-mnop", WatchURL: "https://youtu.be/dQw4w9WgXcQ",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("youtube: %d %s", res.StatusCode, raw)
	}
	calls := strings.Join(h.rooms.egressCalls, "\n")
	if !strings.Contains(calls, "a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop") || !strings.Contains(calls, liIngest) {
		t.Fatalf("want one compositor pushing YouTube and LinkedIn, got:\n%s", calls)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/linkedin", nil)
	li = types.WebinarLinkedIn{}
	h.decode(raw, &li)
	if res.StatusCode != http.StatusOK || !li.Streaming {
		t.Fatalf("live: %d %+v", res.StatusCode, li)
	}

	// Pause: the running compositor is updated in place, not restarted.
	h.rooms.mu.Lock()
	h.rooms.liveEgress = []*livekit.EgressInfo{{
		EgressId: "EG_live", Status: livekit.EgressStatus_EGRESS_ACTIVE,
		StreamResults: []*livekit.StreamInfo{{Url: "rtmp://x"}},
	}}
	h.rooms.egressCalls = nil
	h.rooms.mu.Unlock()

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarLinkedInRequest{Paused: true})
	li = types.WebinarLinkedIn{}
	h.decode(raw, &li)
	if res.StatusCode != http.StatusOK || !li.Paused || li.Streaming {
		t.Fatalf("pause: %d %s", res.StatusCode, raw)
	}
	if got := strings.Join(h.rooms.egressCalls, ","); got != "update:EG_live" {
		t.Fatalf("pause should update the running egress, got %q", got)
	}

	// The mix the sweeper or a recording would start now leaves LinkedIn out.
	paused, err := h.store.WebinarLinkedInPaused(context.Background(), wb.ID)
	if err != nil || !paused {
		t.Fatalf("paused flag: %v %v", paused, err)
	}

	h.rooms.mu.Lock()
	h.rooms.egressCalls = nil
	h.rooms.mu.Unlock()
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarLinkedInRequest{Paused: false})
	li = types.WebinarLinkedIn{}
	h.decode(raw, &li)
	if res.StatusCode != http.StatusOK || li.Paused || !li.Streaming {
		t.Fatalf("resume: %d %s", res.StatusCode, raw)
	}
	if got := strings.Join(h.rooms.egressCalls, ","); got != "update:EG_live" {
		t.Fatalf("resume should update the running egress, got %q", got)
	}
}

func TestLinkedInIsHostOnlyPerWebinar(t *testing.T) {
	h := newHarness(t)
	h.signup("Owner", "owner-li@test.dev", true)
	wb := h.newWebinar("Someone else's room", nil)
	h.signup("Other", "other-li@test.dev", true)

	res, _ := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarLinkedInRequest{Paused: true})
	if res.StatusCode == http.StatusOK {
		t.Fatal("another host paused LinkedIn on a webinar they do not own")
	}
}
