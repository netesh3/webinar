package api_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* "Live captions" as scheduled (Options.Captions) and the caption agent (ai_session.go
 * syncCaptionAgent): ticked means server captions whenever the host has the server captions
 * feature, whatever the AI switch says; on-device only when they are unavailable. Unticking it
 * when editing turns captions off, including during a live session. */

// captionsInput is the edit form's save of wb: what it was created with, as it now stands.
func captionsInput(wb types.Webinar) types.WebinarInput {
	return types.WebinarInput{
		Topic:                wb.Topic,
		StartsAt:             wb.StartsAt,
		Duration:             wb.Duration,
		TimeZone:             wb.TimeZone,
		Kind:                 wb.Kind,
		Status:               wb.Status,
		RegistrationRequired: wb.RegistrationRequired,
		Approval:             wb.Approval,
		AttendeeLimit:        wb.AttendeeLimit,
		Options:              wb.Options,
		Controls:             wb.Controls,
	}
}

func (h *harness) editCaptions(wb types.Webinar, on bool) types.Webinar {
	h.t.Helper()
	in := captionsInput(wb)
	in.Options.Captions = on
	if in.Status == types.StatusLive {
		// What the form sends for a session already running; the store keeps it live.
		in.Status = types.StatusScheduled
	}
	res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID, in)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("edit captions=%v: %d %s", on, res.StatusCode, raw)
	}
	return h.hostWebinar(wb.ID)
}

func withCaptions(in *types.WebinarInput) { in.Options.Captions = true }

func TestScheduledCaptionsUseTheServerWithAIOff(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Captions No AI", "capset-noai@test.dev", true)
	serverCaptionsHost(t, h)

	wb := h.liveWebinar("Captions without AI", withCaptions)
	room := "webinar_" + wb.ID
	if c := h.hostWebinar(wb.ID).Controls; c.AIEnabled {
		t.Fatalf("fixture: AI on (%+v), want off for this test", c)
	}
	if name, ok := h.rooms.dispatched(room); !ok || name != "webinar-captions" {
		t.Fatalf("dispatch on go-live = %q %v, want the caption agent with AI off", name, ok)
	}
	h.rooms.mu.Lock()
	meta := h.rooms.dispatchMeta[room]
	h.rooms.mu.Unlock()
	if strings.Contains(meta, "transcript") {
		t.Fatalf("dispatch metadata = %s, want captions, not transcript only", meta)
	}
	// Asked for, not live yet: the host is told, and the browsers caption meanwhile.
	c := h.hostWebinar(wb.ID).Controls
	if !c.CaptionsEnabled || c.ServerCaptions || !c.ServerCaptionsPending {
		t.Fatalf("controls before the agent is live = %+v, want captions on and server pending", c)
	}
	if meta := h.rooms.roomMeta(t, room); !meta.Controls.ServerCaptionsPending {
		t.Fatal("room metadata does not say server captions are starting")
	}
	h.agentPost("/api/internal/captions/status", testCaptionsSecret, map[string]string{"room": room, "state": "live"})
	c = h.hostWebinar(wb.ID).Controls
	if !c.ServerCaptions || c.ServerCaptionsPending {
		t.Fatalf("controls after the agent went live = %+v", c)
	}
}

func TestScheduledCaptionsFallBackOnDeviceWithoutTheFeature(t *testing.T) {
	h := newHarness(t, captionsConfig)
	email := "capset-nofeature@test.dev"
	h.signup("Captions No Feature", email, true)
	u, _ := h.store.UserByEmail(context.Background(), email)
	off := false
	if _, err := h.store.SetFeatureOverride(context.Background(), u.ID, types.FeatureCaptions, &off); err != nil {
		t.Fatal(err)
	}

	wb := h.liveWebinar("On-device captions", withCaptions)
	if _, ok := h.rooms.dispatched("webinar_" + wb.ID); ok {
		t.Fatal("caption agent dispatched for a host without server captions")
	}
	c := h.hostWebinar(wb.ID).Controls
	if !c.CaptionsEnabled || c.ServerCaptions || c.ServerCaptionsPending {
		t.Fatalf("controls = %+v, want on-device captions on", c)
	}
}

func TestHostJoinRetriesAFailedCaptionDispatch(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Captions Retry", "capset-retry@test.dev", true)
	serverCaptionsHost(t, h)
	h.rooms.mu.Lock()
	h.rooms.dispatchErr = errors.New("agent dispatch unavailable")
	h.rooms.mu.Unlock()

	wb := h.liveWebinar("Captions retry", withCaptions)
	room := "webinar_" + wb.ID
	if c := h.hostWebinar(wb.ID).Controls; !c.CaptionsEnabled || c.ServerCaptionsPending {
		t.Fatalf("controls after a failed dispatch = %+v, want on-device captions", c)
	}

	h.rooms.mu.Lock()
	h.rooms.dispatchErr = nil
	h.rooms.mu.Unlock()
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/join", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("host join: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); !ok {
		t.Fatal("the host's join did not retry the caption agent")
	}
	if meta := h.rooms.roomMeta(t, room); !meta.Controls.ServerCaptionsPending {
		t.Fatal("room metadata not pushed after the retried dispatch")
	}
}

func TestUntickingLiveCaptionsTurnsThemOff(t *testing.T) {
	h := newHarness(t, captionsConfig)
	h.signup("Captions Edit", "capset-edit@test.dev", true)
	serverCaptionsHost(t, h)

	// Scheduled: the option and the control follow each other both ways.
	wb := h.newWebinar("Captions edit", withCaptions)
	if !wb.Controls.CaptionsEnabled {
		t.Fatal("ticked at creation, captions control off")
	}
	wb = h.editCaptions(wb, false)
	if wb.Controls.CaptionsEnabled || wb.Options.Captions {
		t.Fatalf("after unticking: option %v control %v, want both off", wb.Options.Captions, wb.Controls.CaptionsEnabled)
	}
	wb = h.editCaptions(wb, true)
	if !wb.Controls.CaptionsEnabled {
		t.Fatal("ticking again did not turn captions on")
	}
	// A save that leaves the option alone keeps the control as it is, so captions the host
	// switched off in the room are not switched back on by an edit to the title.
	off := false
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{CaptionsEnabled: &off}); res.StatusCode != http.StatusOK {
		t.Fatalf("controls: %d %s", res.StatusCode, raw)
	}
	wb = h.hostWebinar(wb.ID)
	wb = h.editCaptions(wb, true)
	if wb.Controls.CaptionsEnabled {
		t.Fatal("an edit that left the option alone turned captions back on")
	}

	// Live: unticking stops the caption agent now, and ticking brings it back.
	live := h.liveWebinar("Captions edit live", withCaptions)
	room := "webinar_" + live.ID
	if _, ok := h.rooms.dispatched(room); !ok {
		t.Fatal("fixture: no caption agent on go-live")
	}
	live = h.editCaptions(h.hostWebinar(live.ID), false)
	if live.Controls.CaptionsEnabled {
		t.Fatal("unticking during the session left captions on")
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("unticking during the session left the caption agent in the room")
	}
	if meta := h.rooms.roomMeta(t, room); meta.Controls.CaptionsEnabled {
		t.Fatal("room metadata still says captions are on")
	}
	live = h.editCaptions(live, true)
	if _, ok := h.rooms.dispatched(room); !ok || !live.Controls.CaptionsEnabled {
		t.Fatalf("ticking during the session: dispatched %v, controls %+v", ok, live.Controls)
	}
}
