package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/media"
	"github.com/netkumar/webcast/api/types"
)

const mixRecSecret = "mixrec-secret-mixrec-secret-mixrec-32"

// fakeMixRecorder is the sidecar on the SFU box: it records which jobs it was given.
type fakeMixRecorder struct {
	mu     sync.Mutex
	calls  []string // "op:recordingId:slug"
	status int      // answer for every call; 0 is 200
	srv    *httptest.Server
}

func newFakeMixRecorder(t *testing.T) *fakeMixRecorder {
	f := &fakeMixRecorder{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Mixrec-Secret") != mixRecSecret {
			http.Error(w, "bad secret", http.StatusUnauthorized)
			return
		}
		var job struct{ RecordingID, Slug string }
		_ = json.NewDecoder(r.Body).Decode(&job)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, strings.TrimPrefix(r.URL.Path, "/v1/")+":"+job.RecordingID+":"+job.Slug)
		if f.status != 0 {
			w.WriteHeader(f.status)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMixRecorder) ops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// signingDisk is disk storage that can sign uploads, as object storage can.
type signingDisk struct{ *media.Disk }

func (signingDisk) PresignedPutURL(_ context.Context, key, contentType string, _ time.Duration) (string, error) {
	return "https://bucket.test/" + key + "?signed=1&type=" + contentType, nil
}

func mixRecConfig(rec *fakeMixRecorder) func(*config.Config) {
	return func(c *config.Config) {
		edgeRecordingConfig(c)
		c.MixRecSecret = mixRecSecret
		c.MixRecURL = rec.srv.URL
	}
}

func (h *harness) internal(path, secret string, body any) (*http.Response, []byte) {
	h.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Mixrec-Secret", secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

func startCloudRecording(t *testing.T, h *harness, slug string) types.Recording {
	t.Helper()
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/recordings",
		types.StartRecordingRequest{Mime: "video/mp4"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("start recording: %d %s", res.StatusCode, raw)
	}
	var rec types.Recording
	h.decode(raw, &rec)
	return rec
}

/* With an edge mix running, Record gives that mix a second output to MediaMTX's rec/ path and
 * asks the box's recorder to collect it: no second compositor, nothing stopped, and Stop only
 * takes the output off again. The recorder's report is what makes the row ready. */
func TestRecordingFromTheEdgeMix(t *testing.T) {
	recorder := newFakeMixRecorder(t)
	h := newHarness(t, mixRecConfig(recorder))
	api.SetRecordings(h.server, signingDisk{h.recordings})
	wb, mix := liveEdgeMix(t, h, "mixrec@test.dev")
	recURL := "rtmp://origin.test/rec/" + wb.ID

	rec := startCloudRecording(t, h, wb.ID)
	if rec.EgressID != "MIXREC_"+rec.ID {
		t.Fatalf("egress id = %q, want the mix-recording marker", rec.EgressID)
	}
	h.rooms.mu.Lock()
	templates := slices.Clone(h.rooms.templates)
	adds := slices.Clone(h.rooms.streamAdds)
	stopped := slices.Clone(h.rooms.stoppedEgress)
	calls := slices.Clone(h.rooms.egressCalls)
	h.rooms.mu.Unlock()
	if len(templates) != 1 || !strings.HasPrefix(templates[0], "mix=") {
		t.Fatalf("templates = %v, want only the mix: no second compositor", templates)
	}
	if !slices.Contains(adds, recURL) || !slices.Contains(calls, "update:"+mix) {
		t.Fatalf("the mix %s was not given %s: adds %v calls %v", mix, recURL, adds, calls)
	}
	if len(stopped) != 0 || api.ActiveBroadcast(wb.ID) != mix {
		t.Fatalf("recording touched the mix: stopped %v, mix %q", stopped, api.ActiveBroadcast(wb.ID))
	}
	if got, want := recorder.ops(), []string{"start:" + rec.ID + ":" + wb.ID}; !slices.Equal(got, want) {
		t.Fatalf("recorder calls = %v, want %v", got, want)
	}

	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recordings/"+rec.ID+"/complete", nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "stopping") {
		t.Fatalf("stop: %d %s", res.StatusCode, raw)
	}
	h.rooms.mu.Lock()
	removes := slices.Clone(h.rooms.streamRemoves)
	stopped = slices.Clone(h.rooms.stoppedEgress)
	h.rooms.mu.Unlock()
	if !slices.Equal(removes, []string{recURL}) {
		t.Fatalf("stop detached %v, want only %s", removes, recURL)
	}
	if len(stopped) != 0 || api.ActiveBroadcast(wb.ID) != mix {
		t.Fatalf("stop touched the mix: stopped %v, mix %q", stopped, api.ActiveBroadcast(wb.ID))
	}
	if ops := recorder.ops(); len(ops) != 2 || ops[1] != "stop:"+rec.ID+":"+wb.ID {
		t.Fatalf("recorder calls = %v, want start then stop", ops)
	}

	// The recorder asks where to put the file, then reports it.
	res, raw = h.internal("/api/internal/mix-recordings/"+rec.ID+"/upload-url", mixRecSecret, nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "bucket.test/") ||
		!strings.Contains(string(raw), rec.ID+".mp4") {
		t.Fatalf("upload url: %d %s", res.StatusCode, raw)
	}
	res, raw = h.internal("/api/internal/mix-recordings/"+rec.ID+"/complete", mixRecSecret,
		map[string]int64{"sizeBytes": 123456, "durationMs": 61000})
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "ready") {
		t.Fatalf("complete: %d %s", res.StatusCode, raw)
	}
	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/recordings", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("list: %d %s", res.StatusCode, raw)
	}
	var list []types.Recording
	h.decode(raw, &list)
	if len(list) != 1 || list[0].Status != types.RecordingReady || list[0].SizeBytes != 123456 ||
		list[0].DurationMs < 61000 {
		t.Fatalf("recordings = %+v, want one ready 123456-byte 61s recording", list)
	}
}

// The recorder's endpoints take its secret and only act on recordings made from a mix.
func TestMixRecorderEndpointsAuth(t *testing.T) {
	recorder := newFakeMixRecorder(t)
	h := newHarness(t, mixRecConfig(recorder))
	api.SetRecordings(h.server, signingDisk{h.recordings})
	wb, _ := liveEdgeMix(t, h, "mixrec-auth@test.dev")
	rec := startCloudRecording(t, h, wb.ID)

	for _, secret := range []string{"", "wrong-wrong-wrong-wrong-wrong-wrong-32"} {
		res, raw := h.internal("/api/internal/mix-recordings/"+rec.ID+"/complete", secret,
			map[string]int64{"sizeBytes": 1})
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("secret %q: %d %s, want 401", secret, res.StatusCode, raw)
		}
	}
	// A recording that is not from a mix (a composite here) is not the recorder's.
	plain := h.liveWebinar("Plain", nil)
	other := startCloudRecording(t, h, plain.ID)
	res, raw := h.internal("/api/internal/mix-recordings/"+other.ID+"/complete", mixRecSecret,
		map[string]int64{"sizeBytes": 1})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("non-mix recording: %d %s, want 404", res.StatusCode, raw)
	}
	// A report of failure marks the row failed rather than ready.
	res, raw = h.internal("/api/internal/mix-recordings/"+rec.ID+"/complete", mixRecSecret,
		map[string]any{"sizeBytes": 10, "error": "no segments"})
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "failed") {
		t.Fatalf("failed report: %d %s", res.StatusCode, raw)
	}
}

// Without MIXREC_SECRET the endpoints do not exist.
func TestMixRecorderEndpointsOffWithoutSecret(t *testing.T) {
	h := newHarness(t, edgeRecordingConfig)
	res, _ := h.internal("/api/internal/mix-recordings/x/complete", mixRecSecret, map[string]int64{})
	if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("endpoint answered %d without a secret configured", res.StatusCode)
	}
}

/* Record-from-mix unavailable — the recorder down, or the mix refusing the output — falls back
 * to the recording's own compositor (#613), and a refused attach cancels the recorder's job. */
func TestRecordingFromMixFallsBack(t *testing.T) {
	t.Run("recorder down", func(t *testing.T) {
		recorder := newFakeMixRecorder(t)
		recorder.status = http.StatusBadGateway
		h := newHarness(t, mixRecConfig(recorder))
		api.SetRecordings(h.server, signingDisk{h.recordings})
		wb, mix := liveEdgeMix(t, h, "mixrec-down@test.dev")
		rec := startCloudRecording(t, h, wb.ID)
		if rec.EgressID == "" || strings.HasPrefix(rec.EgressID, "MIXREC_") || rec.EgressID == mix {
			t.Fatalf("egress id = %q, want a compositor of its own", rec.EgressID)
		}
		h.rooms.mu.Lock()
		adds := slices.Clone(h.rooms.streamAdds)
		h.rooms.mu.Unlock()
		if slices.Contains(adds, "rtmp://origin.test/rec/"+wb.ID) {
			t.Fatalf("the mix was given the recording output with no recorder: %v", adds)
		}
	})
	t.Run("mix refuses the output", func(t *testing.T) {
		recorder := newFakeMixRecorder(t)
		h := newHarness(t, mixRecConfig(recorder))
		api.SetRecordings(h.server, signingDisk{h.recordings})
		wb, _ := liveEdgeMix(t, h, "mixrec-refused@test.dev")
		h.rooms.mu.Lock()
		h.rooms.refuseStream = map[string]bool{"rtmp://origin.test/rec/" + wb.ID: true}
		h.rooms.mu.Unlock()
		rec := startCloudRecording(t, h, wb.ID)
		if strings.HasPrefix(rec.EgressID, "MIXREC_") {
			t.Fatalf("egress id = %q, want a compositor of its own", rec.EgressID)
		}
		if ops := recorder.ops(); len(ops) != 2 || !strings.HasPrefix(ops[1], "cancel:"+rec.ID) {
			t.Fatalf("recorder calls = %v, want start then cancel", ops)
		}
	})
	t.Run("storage cannot sign uploads", func(t *testing.T) {
		recorder := newFakeMixRecorder(t)
		h := newHarness(t, mixRecConfig(recorder)) // plain disk storage
		wb, _ := liveEdgeMix(t, h, "mixrec-disk@test.dev")
		rec := startCloudRecording(t, h, wb.ID)
		if strings.HasPrefix(rec.EgressID, "MIXREC_") || len(recorder.ops()) != 0 {
			t.Fatalf("egress id %q, recorder %v: want the old path untouched", rec.EgressID, recorder.ops())
		}
	})
}

// Standard delivery has no mix through MediaMTX: the recording is a composite, as always.
func TestStandardRecordingIgnoresTheMixRecorder(t *testing.T) {
	recorder := newFakeMixRecorder(t)
	h := newHarness(t, mixRecConfig(recorder))
	api.SetRecordings(h.server, signingDisk{h.recordings})
	h.signup("Std Host", "mixrec-std@test.dev", true)
	grantCloudRecording(t, h)
	wb := h.liveWebinar("Standard", nil)
	rec := startCloudRecording(t, h, wb.ID)
	if strings.HasPrefix(rec.EgressID, "MIXREC_") || len(recorder.ops()) != 0 {
		t.Fatalf("egress id %q, recorder %v: want a plain composite", rec.EgressID, recorder.ops())
	}
}

// A mix that dies mid-recording comes back carrying the recording output too.
func TestReplacementMixKeepsRecording(t *testing.T) {
	defer api.SetMixQuickRestart(10 * time.Millisecond)()
	recorder := newFakeMixRecorder(t)
	h := newHarness(t, mixRecConfig(recorder))
	api.SetRecordings(h.server, signingDisk{h.recordings})
	wb, mix := liveEdgeMix(t, h, "mixrec-restart@test.dev")
	recURL := "rtmp://origin.test/rec/" + wb.ID
	startCloudRecording(t, h, wb.ID)

	h.rooms.mu.Lock()
	h.rooms.liveEgress = nil
	h.rooms.mu.Unlock()
	api.ForgetMixRestarts(wb.ID)
	api.OnBroadcastEgressEnded(h.server, context.Background(), &livekit.EgressInfo{
		EgressId: mix, RoomName: "webinar_" + wb.ID, Status: livekit.EgressStatus_EGRESS_FAILED,
	})
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.rooms.mu.Lock()
		n := 0
		for _, u := range h.rooms.streamAdds {
			if u == recURL {
				n++
			}
		}
		h.rooms.mu.Unlock()
		if n >= 2 {
			return
		}
		if time.Now().After(deadline) {
			h.rooms.mu.Lock()
			defer h.rooms.mu.Unlock()
			t.Fatalf("the replacement mix was not given %s; egress calls %v, adds %v",
				recURL, h.rooms.egressCalls, h.rooms.streamAdds)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
