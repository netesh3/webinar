package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* Scheduling a simulive from a recording (host.go simuliveRecordingField): the recording
 * must be one of the host's own ready ones, an edit that keeps the recording it already
 * plays is not asked again, and anything that is not a simulive drops the recording id. */

func (h *harness) insertRecording(slug, status string, size int64) string {
	h.t.Helper()
	var id string
	if err := h.store.Pool().QueryRow(context.Background(), `
		INSERT INTO recordings (webinar_id, status, mime, storage_key, size_bytes, duration_ms, created_at, stopped_at)
		SELECT id, $2, 'video/mp4', 'aa/bb/'||$1||'.mp4', $3, 1800000, now() - interval '1 hour', now() - interval '30 minutes'
		  FROM webinars WHERE slug = $1 RETURNING id::text`, slug, status, size).Scan(&id); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func simuliveInput(recID string) types.WebinarInput {
	return types.WebinarInput{
		Topic:                "Encore",
		StartsAt:             time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339),
		Duration:             30,
		TimeZone:             "UTC",
		Kind:                 types.KindSimulive,
		SimuliveRecordingID:  recID,
		Status:               types.StatusScheduled,
		RegistrationRequired: true,
		Approval:             types.ApprovalAutomatic,
		AttendeeLimit:        100,
		Controls:             types.SessionControls{ChatEnabled: true, QAEnabled: true},
	}
}

func (h *harness) wantField(res *http.Response, raw []byte, field string) {
	h.t.Helper()
	if res.StatusCode != http.StatusUnprocessableEntity {
		h.t.Fatalf("status %d body %s, want 422 on %s", res.StatusCode, raw, field)
	}
	var apiErr types.APIError
	h.decode(raw, &apiErr)
	if apiErr.Fields[field] == "" {
		h.t.Fatalf("fields %v, want one on %s", apiErr.Fields, field)
	}
}

func TestSimuliveScheduleRecordingRules(t *testing.T) {
	h := newHarness(t)

	// Another host's ready recording.
	h.signup("Other Coach", "other-sim-coach@test.dev", true)
	theirs := h.newWebinar("Their session", nil)
	foreign := h.insertRecording(theirs.ID, "ready", 1000)

	coach := h.signup("Coach Asha", "sim-coach@test.dev", true)
	grantFeature(t, h, coach.ID, types.FeatureSimulive)
	orig := h.newWebinar("Original session", nil)
	ready := h.insertRecording(orig.ID, "ready", 1000)
	processing := h.insertRecording(orig.ID, "processing", 0)
	failed := h.insertRecording(orig.ID, "failed", 0)

	for name, id := range map[string]string{
		"another host's": foreign, "still processing": processing, "failed": failed,
		"not a recording": "00000000-0000-0000-0000-000000000000",
	} {
		res, raw := h.do(http.MethodPost, "/api/host/webinars", simuliveInput(id))
		if res.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s recording: status %d body %s, want 422", name, res.StatusCode, raw)
			continue
		}
		h.wantField(res, raw, "simuliveRecordingId")
	}

	res, raw := h.do(http.MethodPost, "/api/host/webinars", simuliveInput(ready))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("own ready recording: status %d body %s", res.StatusCode, raw)
	}
	var sim types.Webinar
	h.decode(raw, &sim)
	if sim.Kind != types.KindSimulive || sim.SimuliveRecordingID != ready {
		t.Fatalf("created: kind %q recording %q", sim.Kind, sim.SimuliveRecordingID)
	}

	// An edit that points it at someone else's recording is refused.
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+sim.ID, simuliveInput(foreign))
	h.wantField(res, raw, "simuliveRecordingId")

	// An edit that keeps the recording it plays is not asked again, even if the recording
	// has since stopped counting as ready: renaming the session must not be refused.
	h.exec(`UPDATE recordings SET size_bytes = 0 WHERE id = $1::uuid`, ready)
	in := simuliveInput(ready)
	in.Topic = "Encore, renamed"
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+sim.ID, in); res.StatusCode != http.StatusOK {
		t.Fatalf("keep recording: status %d body %s", res.StatusCode, raw)
	}

	// Switched to live with the old id still in the body: the id is dropped, not kept stale.
	in.Kind = types.KindLive
	res, raw = h.do(http.MethodPatch, "/api/host/webinars/"+sim.ID, in)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("to live: status %d body %s", res.StatusCode, raw)
	}
	var live types.Webinar
	h.decode(raw, &live)
	if live.Kind != types.KindLive || live.SimuliveRecordingID != "" {
		t.Fatalf("to live: kind %q recording %q, want live and none", live.Kind, live.SimuliveRecordingID)
	}

	// A live webinar created with a recording id does not keep it either.
	in = simuliveInput(ready)
	in.Kind = types.KindLive
	res, raw = h.do(http.MethodPost, "/api/host/webinars", in)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("live with id: status %d body %s", res.StatusCode, raw)
	}
	h.decode(raw, &live)
	if live.SimuliveRecordingID != "" {
		t.Fatalf("live webinar kept recording %q", live.SimuliveRecordingID)
	}
}
