package api_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

func egressRecordingConfig(c *config.Config) {
	c.RecordingsMode = "egress"
	c.RecordingsEgressTemplateURL = recTemplate
}

// onStage puts a host in the room with their camera and mic up.
func onStage(h *harness) {
	h.rooms.mu.Lock()
	h.rooms.roster = []types.LiveParticipant{{
		Identity: "user_host", Name: "Host", Role: types.RoleHost,
		Publishing: []string{"VIDEO/CAMERA", "AUDIO/MICROPHONE"}, CanPublish: true,
	}}
	h.rooms.mu.Unlock()
}

// recordCalls is every composite recording the fake was asked to start.
func recordCalls(h *harness) []string {
	h.rooms.mu.Lock()
	defer h.rooms.mu.Unlock()
	var out []string
	for _, t := range h.rooms.templates {
		if strings.HasPrefix(t, "record=") || strings.HasPrefix(t, "both=") {
			out = append(out, t)
		}
	}
	return out
}

// settle gives Go live's background attempt time to finish.
func settle() { time.Sleep(150 * time.Millisecond) }

func autoRecordWebinar(h *harness, topic string, mutate func(*types.WebinarInput)) types.Webinar {
	return h.liveWebinar(topic, func(in *types.WebinarInput) {
		in.Options.AutoRecord = true
		if mutate != nil {
			mutate(in)
		}
	})
}

/* "Record automatically" used to be stored and shown, and never start anything. A live
 * webinar with it on starts exactly one cloud recording once somebody is publishing on the
 * stage — not while the room is empty, and not a second one on later passes. */
func TestAutoRecordStartsOneRecordingOnceTheStageIsLive(t *testing.T) {
	h := newHarness(t, egressRecordingConfig)
	h.signup("Auto Host", "auto-rec@test.dev", true)
	grantCloudRecording(t, h)
	wb := autoRecordWebinar(h, "Auto recorded", nil)
	settle()

	// Live, but nobody on camera: nothing to record yet.
	h.server.RunTick(context.Background())
	if calls := recordCalls(h); len(calls) != 0 {
		t.Fatalf("an empty room was recorded: %v", calls)
	}

	onStage(h)
	h.server.RunTick(context.Background())
	h.server.RunTick(context.Background())
	settle()

	if calls := recordCalls(h); len(calls) != 1 || calls[0] != "record="+recTemplate {
		t.Fatalf("recordings started = %v, want exactly one composite", calls)
	}
	list, err := h.store.Recordings(context.Background(), wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Status != types.RecordingActive || list[0].EgressID == "" {
		t.Fatalf("recordings = %+v, want one running egress recording", list)
	}

	// The room is told, and told it was automatic, for the host's notice.
	h.rooms.mu.Lock()
	raw := h.rooms.metadata[lk.RoomName(wb.ID)]
	h.rooms.mu.Unlock()
	var meta types.RoomMeta
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		t.Fatalf("room metadata %q: %v", raw, err)
	}
	if !meta.Recording || !meta.RecordingAuto {
		t.Fatalf("room metadata = %+v, want recording and recordingAuto", meta)
	}

	// The host stops it: the option does not start another behind their back.
	if _, err := h.store.FinishRecording(context.Background(), list[0].ID, 1000); err != nil {
		t.Fatal(err)
	}
	h.server.RunTick(context.Background())
	if calls := recordCalls(h); len(calls) != 1 {
		t.Fatalf("a stopped automatic recording was started again: %v", calls)
	}
}

// Without the host's cloud recording switch the option is ignored, even on a webinar saved
// while they had it.
func TestAutoRecordNeedsCloudRecording(t *testing.T) {
	h := newHarness(t, egressRecordingConfig)
	host := h.signup("Auto Host", "auto-rec-off@test.dev", true)
	grantCloudRecording(t, h)
	autoRecordWebinar(h, "Auto recorded, switch gone", nil)
	if _, err := h.store.SetFeature(context.Background(), host.ID, types.FeatureCloudRecording, false); err != nil {
		t.Fatal(err)
	}
	onStage(h)
	h.server.RunTick(context.Background())
	settle()
	if calls := recordCalls(h); len(calls) != 0 {
		t.Fatalf("recorded without cloud recording: %v", calls)
	}
}

// Off means off: a live webinar without the option is not recorded.
func TestAutoRecordOffRecordsNothing(t *testing.T) {
	h := newHarness(t, egressRecordingConfig)
	h.signup("Plain Host", "auto-rec-none@test.dev", true)
	grantCloudRecording(t, h)
	h.liveWebinar("Not recorded", nil)
	onStage(h)
	h.server.RunTick(context.Background())
	settle()
	if calls := recordCalls(h); len(calls) != 0 {
		t.Fatalf("recorded without the option: %v", calls)
	}
}

/* Edge delivery records from the running mix (mixrec.go), as Record does: no second
 * compositor, and only once the mix is up. */
func TestAutoRecordOnEdgeRecordsTheMix(t *testing.T) {
	recorder := newFakeMixRecorder(t)
	h := newHarness(t, mixRecConfig(recorder))
	api.SetRecordings(h.server, signingDisk{h.recordings})
	edgeHost(t, h, "auto-rec-edge@test.dev")
	grantCloudRecording(t, h)
	onStage(h)
	wb := autoRecordWebinar(h, "Auto recorded edge", func(in *types.WebinarInput) {
		in.Delivery = types.DeliveryEdge
	})
	origin := "rtmp://origin.test/live/" + wb.ID
	waitForCalls(t, h, origin)
	deadline := time.Now().Add(3 * time.Second)
	for api.ActiveBroadcast(wb.ID) == "starting" || api.ActiveBroadcast(wb.ID) == "" {
		if time.Now().After(deadline) {
			t.Fatal("the mix never recorded its egress id")
		}
		time.Sleep(10 * time.Millisecond)
	}
	settle()
	// The mix is not reported running yet: the recording waits for it rather than racing it.
	if ops := recorder.ops(); len(ops) != 0 {
		t.Fatalf("recorded before the mix was up: %v", ops)
	}
	mix := api.ActiveBroadcast(wb.ID)
	h.rooms.mu.Lock()
	h.rooms.liveEgress = []*livekit.EgressInfo{{
		EgressId: mix, Status: livekit.EgressStatus_EGRESS_ACTIVE,
		StreamResults: []*livekit.StreamInfo{{Url: origin}},
	}}
	h.rooms.mu.Unlock()

	h.server.RunTick(context.Background())
	h.server.RunTick(context.Background())

	list, err := h.store.Recordings(context.Background(), wb.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].EgressID != "MIXREC_"+list[0].ID {
		t.Fatalf("recordings = %+v, want one recording from the mix", list)
	}
	if got, want := recorder.ops(), []string{"start:" + list[0].ID + ":" + wb.ID}; !slices.Equal(got, want) {
		t.Fatalf("recorder calls = %v, want %v", got, want)
	}
	if calls := recordCalls(h); len(calls) != 0 {
		t.Fatalf("a second compositor was started: %v", calls)
	}
}
