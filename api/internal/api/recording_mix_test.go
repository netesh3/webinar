package api_test

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

const recTemplate = "https://web.test/recorder-template"

func edgeRecordingConfig(c *config.Config) {
	edgeConfig(c)
	c.RecordingsMode = "egress"
	c.RecordingsEgressTemplateURL = recTemplate
}

// liveEdgeMix starts an edge webinar, waits for its mix and reports it to the fake as running.
func liveEdgeMix(t *testing.T, h *harness, email string) (types.Webinar, string) {
	t.Helper()
	edgeHost(t, h, email)
	grantCloudRecording(t, h)
	wb := edgeWebinar(h, "Recorded edge session")
	origin := "rtmp://origin.test/live/" + wb.ID
	waitForCalls(t, h, origin)
	deadline := time.Now().Add(3 * time.Second)
	for api.ActiveBroadcast(wb.ID) == "starting" || api.ActiveBroadcast(wb.ID) == "" {
		if time.Now().After(deadline) {
			t.Fatal("the mix never recorded its egress id")
		}
		time.Sleep(10 * time.Millisecond)
	}
	mix := api.ActiveBroadcast(wb.ID)
	h.rooms.mu.Lock()
	h.rooms.liveEgress = []*livekit.EgressInfo{{
		EgressId: mix, Status: livekit.EgressStatus_EGRESS_ACTIVE,
		StreamResults: []*livekit.StreamInfo{{Url: origin}},
	}}
	h.rooms.mu.Unlock()
	return wb, mix
}

/* Pressing Record never touches the audience's stream, and neither does Stop.
 *
 * Production, 2026-10-22 (instant-webinar-0375): the recording stopped the edge mix to start
 * one egress with both outputs, every viewer went to "reconnecting", and the replacement
 * loaded the plain template instead of <template>/edge, so the layout changed as well. */
func TestRecordingLeavesTheEdgeMixAlone(t *testing.T) {
	defer api.SetBroadcastRestartDelay(10 * time.Millisecond)()
	h := newHarness(t, edgeRecordingConfig)
	wb, mix := liveEdgeMix(t, h, "rec-mix@test.dev")

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/mp4"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: %d %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)

	h.rooms.mu.Lock()
	stopped := slices.Clone(h.rooms.stoppedEgress)
	templates := slices.Clone(h.rooms.templates)
	h.rooms.mu.Unlock()
	if len(stopped) != 0 {
		t.Fatalf("starting a recording stopped %v; the mix %s must keep running", stopped, mix)
	}
	if got := api.ActiveBroadcast(wb.ID); got != mix {
		t.Fatalf("the room's mix is now %q, want %q untouched", got, mix)
	}
	if rec.EgressID == "" || rec.EgressID == mix {
		t.Fatalf("recording egress = %q, want its own egress beside the mix %s", rec.EgressID, mix)
	}
	// Both drawn from the edge page, so the file is what the audience sees, and nothing
	// the recording starts can lay the audience's picture out differently.
	want := []string{"mix=" + recTemplate + "/edge", "record=" + recTemplate + "/edge"}
	if !slices.Equal(templates, want) {
		t.Fatalf("templates = %v, want %v", templates, want)
	}

	// Stop: only the recording ends, and no mix is "put back" over the running one.
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/complete", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("stop recording: %d %s", res.StatusCode, raw)
	}
	time.Sleep(100 * time.Millisecond)
	h.rooms.mu.Lock()
	stopped = slices.Clone(h.rooms.stoppedEgress)
	templates = slices.Clone(h.rooms.templates)
	h.rooms.mu.Unlock()
	if !slices.Equal(stopped, []string{rec.EgressID}) {
		t.Fatalf("stopping the recording stopped %v, want only %s", stopped, rec.EgressID)
	}
	if len(templates) != 2 {
		t.Fatalf("stopping the recording started another egress: %v", templates)
	}
	if got := api.ActiveBroadcast(wb.ID); got != mix {
		t.Fatalf("after stop the room's mix is %q, want %q", got, mix)
	}
}

/* No room for a second compositor: the host is told, and the audience keeps watching. The old
 * answer — take the mix's place — is the outage above. */
func TestRecordingRefusedBesideTheMixKeepsTheMix(t *testing.T) {
	h := newHarness(t, edgeRecordingConfig)
	wb, mix := liveEdgeMix(t, h, "rec-full@test.dev")
	h.rooms.mu.Lock()
	h.rooms.recordErr = errors.New("twirp error resource_exhausted: no egress servers available")
	h.rooms.mu.Unlock()

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/mp4"})
	if res.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(raw), "recording_no_capacity") {
		t.Fatalf("start recording with no room: %d %s, want 503 recording_no_capacity", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	stopped := slices.Clone(h.rooms.stoppedEgress)
	templates := slices.Clone(h.rooms.templates)
	h.rooms.mu.Unlock()
	if len(stopped) != 0 || api.ActiveBroadcast(wb.ID) != mix {
		t.Fatalf("a refused recording touched the mix: stopped %v, mix now %q", stopped, api.ActiveBroadcast(wb.ID))
	}
	for _, tpl := range templates {
		if strings.HasPrefix(tpl, "both=") {
			t.Fatalf("a refused recording fell back to replacing the mix: %v", templates)
		}
	}

	// The failed attempt left nothing open: the next try is not "already recording".
	h.rooms.mu.Lock()
	h.rooms.recordErr = nil
	h.rooms.mu.Unlock()
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/mp4"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("retry once there is room: %d %s", res.StatusCode, raw)
	}
}

/* With no mix up yet, an edge recording carries the audience's push from the start, on the
 * audience's template — not the plain one, which is what changed the layout. */
func TestEdgeRecordingWithoutAMixUsesTheEdgeTemplate(t *testing.T) {
	h := newHarness(t, func(c *config.Config) {
		edgeRecordingConfig(c)
	})
	edgeHost(t, h, "rec-nomix@test.dev")
	grantCloudRecording(t, h)
	wb := h.newWebinar("Edge, not started", func(in *types.WebinarInput) { in.Delivery = types.DeliveryEdge })

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings",
		types.StartRecordingRequest{Mime: "video/mp4"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: %d %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	templates := slices.Clone(h.rooms.templates)
	h.rooms.mu.Unlock()
	if want := []string{"both=" + recTemplate + "/edge"}; !slices.Equal(templates, want) {
		t.Fatalf("templates = %v, want %v", templates, want)
	}
}
