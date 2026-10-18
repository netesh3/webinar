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
	var li types.WebinarStreamDestination
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
	// One compositor: started on the first destination, every other one attached to it
	// with its own UpdateStream (so a refused key costs only that platform).
	calls := h.rooms.pushedURLs()
	if !strings.Contains(calls, "a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop") || !strings.Contains(calls, liIngest) {
		t.Fatalf("want one compositor pushing YouTube and LinkedIn, got:\n%s", calls)
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/linkedin", nil)
	li = types.WebinarStreamDestination{}
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

	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarStreamPausedRequest{Paused: true})
	li = types.WebinarStreamDestination{}
	h.decode(raw, &li)
	if res.StatusCode != http.StatusOK || !li.Paused || li.Streaming {
		t.Fatalf("pause: %d %s", res.StatusCode, raw)
	}
	if got := strings.Join(h.rooms.egressCalls, ","); got != "update:EG_live" {
		t.Fatalf("pause should update the running egress, got %q", got)
	}

	// The mix the sweeper or a recording would start now leaves LinkedIn out.
	paused, err := h.store.WebinarStreamPaused(context.Background(), wb.ID, "linkedin")
	if err != nil || !paused {
		t.Fatalf("paused flag: %v %v", paused, err)
	}

	h.rooms.mu.Lock()
	h.rooms.egressCalls = nil
	h.rooms.mu.Unlock()
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarStreamPausedRequest{Paused: false})
	li = types.WebinarStreamDestination{}
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

	res, _ := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/linkedin", types.SetWebinarStreamPausedRequest{Paused: true})
	if res.StatusCode == http.StatusOK {
		t.Fatal("another host paused LinkedIn on a webinar they do not own")
	}
}

func cardByID(t *testing.T, h *harness, raw []byte, id string) types.IntegrationCard {
	t.Helper()
	var list types.IntegrationsResponse
	h.decode(raw, &list)
	for _, c := range list.Integrations {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no %s card in %s", id, raw)
	return types.IntegrationCard{}
}

/* Instagram and Facebook work exactly like LinkedIn: saved on the account, all
 * pushed by the one compositor, and paused per room independently. */
func TestInstagramAndFacebookStreamBesideLinkedIn(t *testing.T) {
	h := newHarness(t)
	h.signup("Coach", "coach-ig-fb@test.dev", true)
	wb := h.newWebinar("Everywhere at once", nil)

	const (
		igURL = "rtmps://edgetee-upload-bom1-1.xx.fbcdn.net:443/rtmp/"
		igKey = "17999?s_bl=1&s_sc=1&a=IGKEY"
		fbURL = "rtmps://live-api-s.facebook.com:443/rtmp/"
		fbKey = "FB-1234-0-AbCdEf?s_bl=1&a=FBKEY"
	)
	res, raw := h.do(http.MethodPut, "/api/host/integrations/instagram-live", types.SaveStreamKeyRequest{StreamURL: "", StreamKey: igKey})
	if res.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(raw), "Instagram") {
		t.Fatalf("instagram missing url: %d %s", res.StatusCode, raw)
	}
	for _, c := range []struct{ href, url, key, card string }{
		{"/api/host/integrations/linkedin", liStreamURL, liKey, "linkedin"},
		{"/api/host/integrations/instagram-live", igURL, igKey, "instagram-live"},
		{"/api/host/integrations/facebook-live", fbURL, fbKey, "facebook-live"},
	} {
		res, raw = h.do(http.MethodPut, c.href, types.SaveStreamKeyRequest{StreamURL: c.url, StreamKey: c.key})
		if res.StatusCode != http.StatusOK || strings.Contains(string(raw), "KEY") {
			t.Fatalf("save %s: %d %s", c.card, res.StatusCode, raw)
		}
		if card := cardByID(t, h, raw, c.card); card.Status != types.IntegrationStatusConnected {
			t.Fatalf("%s card: %+v", c.card, card)
		}
	}
	// The coming-soon Instagram messaging card is a different card.
	if card := cardByID(t, h, raw, "instagram"); card.Status != types.IntegrationStatusSoon {
		t.Fatalf("instagram messaging card changed: %+v", card)
	}

	h.goLive(wb.ID)
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/stream", types.SetStreamRequest{
		StreamKey: "abcd-efgh-ijkl-mnop", WatchURL: "https://youtu.be/dQw4w9WgXcQ",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("youtube: %d %s", res.StatusCode, raw)
	}
	calls := h.rooms.pushedURLs()
	for _, want := range []string{"abcd-efgh-ijkl-mnop", liIngest, igURL + igKey, fbURL + fbKey} {
		if !strings.Contains(calls, want) {
			t.Fatalf("want %q pushed by the one compositor, got:\n%s", want, calls)
		}
	}

	for _, id := range []string{"instagram", "facebook"} {
		var d types.WebinarStreamDestination
		res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/"+id, nil)
		h.decode(raw, &d)
		if res.StatusCode != http.StatusOK || !d.Streaming || d.Platform != id {
			t.Fatalf("%s status: %d %s", id, res.StatusCode, raw)
		}
	}

	// Pausing Instagram leaves Facebook and LinkedIn streaming.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/instagram", types.SetWebinarStreamPausedRequest{Paused: true})
	var ig types.WebinarStreamDestination
	h.decode(raw, &ig)
	if res.StatusCode != http.StatusOK || !ig.Paused || ig.Streaming {
		t.Fatalf("pause instagram: %d %s", res.StatusCode, raw)
	}
	var fb types.WebinarStreamDestination
	_, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/facebook", nil)
	h.decode(raw, &fb)
	if !fb.Streaming || fb.Paused {
		t.Fatalf("facebook should still stream: %s", raw)
	}
}
