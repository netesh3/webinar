package api_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/types"
)

/* The room's AI switch (ai_session.go): on by default for an account with the ai feature and
 * absent for one without; persisted and broadcast like any control; while on, the caption agent
 * keeps a transcript with captions hidden; off at the end, no recap. */

func (h *harness) patchAI(slug string, on bool) (*http.Response, []byte) {
	h.t.Helper()
	return h.do(http.MethodPatch, "/api/host/webinars/"+slug+"/controls", types.ControlsPatch{AIEnabled: &on})
}

func (h *harness) hostWebinar(slug string) types.Webinar {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug, nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("get webinar: %d %s", res.StatusCode, raw)
	}
	var wb types.Webinar
	h.decode(raw, &wb)
	return wb
}

func TestAISwitchFollowsTheAccountAndIsPersistedAndBroadcast(t *testing.T) {
	h := newHarness(t)
	email := "aisw-host@test.dev"
	h.signup("AI Switch Host", email, true)

	// Without the feature: off, unavailable, and it cannot be turned on.
	plain := h.newWebinar("No AI here", nil)
	if c := plain.Controls; c.AIEnabled || c.AIAvailable {
		t.Fatalf("controls without the feature = %+v, want AI off and unavailable", c)
	}
	if res, raw := h.patchAI(plain.ID, true); res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("turn on without the feature: %d %s", res.StatusCode, raw)
	}

	// With it: on by default, for new sessions and for the existing one.
	enableAI(t, h, email)
	wb := h.liveWebinar("AI on by default", nil)
	if c := wb.Controls; !c.AIEnabled || !c.AIAvailable {
		t.Fatalf("controls with the feature = %+v, want AI on", c)
	}
	if c := h.hostWebinar(plain.ID).Controls; !c.AIEnabled || !c.AIAvailable {
		t.Fatalf("existing session after the feature = %+v, want AI on", c)
	}

	// Off: persisted, and in the room metadata every browser reads.
	room := "webinar_" + wb.ID
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("off: %d %s", res.StatusCode, raw)
	}
	if h.hostWebinar(wb.ID).Controls.AIEnabled {
		t.Fatal("AI off was not persisted")
	}
	if meta := h.rooms.roomMeta(t, room); meta.Controls.AIEnabled || !meta.Controls.AIAvailable {
		t.Fatalf("room metadata after off = %+v", meta.Controls)
	}
	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("on: %d %s", res.StatusCode, raw)
	}
	if meta := h.rooms.roomMeta(t, room); !meta.Controls.AIEnabled {
		t.Fatal("room metadata after on: AI still off")
	}

	// The feature taken away: the session reads off whatever its own switch says.
	off := false
	u, _ := h.store.UserByEmail(context.Background(), email)
	if _, err := h.store.SetFeatureOverride(context.Background(), u.ID, types.FeatureAI, &off); err != nil {
		t.Fatal(err)
	}
	if c := h.hostWebinar(wb.ID).Controls; c.AIEnabled || c.AIAvailable {
		t.Fatalf("controls after the feature went = %+v", c)
	}
}

func TestAISwitchKeepsATranscriptWithCaptionsHidden(t *testing.T) {
	h := newHarness(t, captionsConfig)
	email := "aisw-transcript@test.dev"
	h.signup("AI Transcript Host", email, true)
	enableAI(t, h, email)
	ctx := context.Background()

	// Going live with AI on dispatches the agent in transcript-only mode; captions stay hidden.
	wb := h.liveWebinar("Silent transcript", nil)
	room := "webinar_" + wb.ID
	if name, ok := h.rooms.dispatched(room); !ok || name != "webinar-captions" {
		t.Fatalf("dispatch on go-live = %q %v, want the caption agent", name, ok)
	}
	h.rooms.mu.Lock()
	meta := h.rooms.dispatchMeta[room]
	h.rooms.mu.Unlock()
	if !strings.Contains(meta, `"mode":"transcript"`) {
		t.Fatalf("dispatch metadata = %s, want transcript mode", meta)
	}
	if c := h.hostWebinar(wb.ID).Controls; c.CaptionsEnabled {
		t.Fatalf("captions turned on by the AI transcript: %+v", c)
	}

	resetSent := func() {
		h.rooms.mu.Lock()
		h.rooms.sent = nil
		h.rooms.mu.Unlock()
	}
	sentCount := func() int {
		h.rooms.mu.Lock()
		defer h.rooms.mu.Unlock()
		return len(h.rooms.sent)
	}
	post := func(text string) int {
		res, raw := h.agentPost("/api/internal/captions", testCaptionsSecret, map[string]any{
			"room": room, "identity": "user_x", "text": text,
		})
		if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusConflict {
			t.Fatalf("caption %q: %d %s", text, res.StatusCode, raw)
		}
		return res.StatusCode
	}

	// Captions hidden: stored, not fanned out.
	resetSent()
	if code := post("kept for the recap only"); code != http.StatusOK {
		t.Fatalf("hidden caption: %d", code)
	}
	if text, _ := h.store.CaptionTranscript(ctx, wb.ID); !strings.Contains(text, "kept for the recap only") {
		t.Fatalf("transcript = %q, want the hidden line", text)
	}
	if n := sentCount(); n != 0 {
		t.Fatalf("packets with captions hidden = %d, want 0", n)
	}

	// Captions shown: stored and fanned out.
	on, offB := true, false
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &on}); res.StatusCode != http.StatusOK {
		t.Fatalf("captions on: %d %s", res.StatusCode, raw)
	}
	resetSent()
	post("shown to everyone")
	if n := sentCount(); n != 1 {
		t.Fatalf("packets with captions shown = %d, want 1", n)
	}

	// Captions hidden again: the agent stays for the AI.
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls", types.ControlsPatch{CaptionsEnabled: &offB}); res.StatusCode != http.StatusOK {
		t.Fatalf("captions off: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); !ok {
		t.Fatal("captions off removed the agent while AI is on")
	}

	// AI off with captions hidden: the agent goes, and a late line is refused.
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("ai off: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("agent still dispatched with AI and captions off")
	}
	if code := post("after everything is off"); code != http.StatusConflict {
		t.Fatalf("caption after off: %d, want 409", code)
	}

	// AI back on mid-session: the session was switched off once, so it stays out of AI
	// (AIOffThisSession) — no transcript agent comes back for it.
	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("ai on: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); ok {
		t.Fatal("AI back on after an off brought the transcript agent back")
	}

	// Captions shown (the room's CC button) bring the agent back for the captions alone, and
	// AI off then leaves it there, for the captions.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/captions/server", map[string]any{"on": true}); res.StatusCode != http.StatusOK {
		t.Fatalf("server captions on: %d %s", res.StatusCode, raw)
	}
	if _, ok := h.rooms.dispatched(room); !ok {
		t.Fatal("CC on did not dispatch the agent")
	}
	h.patchAI(wb.ID, false)
	if _, ok := h.rooms.dispatched(room); !ok {
		t.Fatal("AI off removed the agent while captions are shown")
	}
}

func TestAISwitchOffMeansNoRecap(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	recapHost(t, h)
	wb := h.newWebinar("Off the record", nil)
	h.goLive(wb.ID)
	h.caption(wb.ID, "user_x", "Something nobody wants summarised")
	h.question(wb.ID, "oq1", "Is this private?", 2)
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("ai off: %d %s", res.StatusCode, raw)
	}
	h.endSession(wb.ID)
	h.runRecaps()
	if got := h.getRecap(wb.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonAISessionOff {
		t.Fatalf("recap = %+v, want skipped ai_session_off", got)
	}
	if model.callCount() != 0 {
		t.Fatalf("model calls = %d, want none", model.callCount())
	}
	if m := h.recapMails(wb.ID); len(m) != 0 {
		t.Fatalf("mails = %+v, want none", m)
	}
}

/* Any "off" while live keeps the whole session out of AI, even if AI is switched back on
 * before the end (decided 2026-10-22). The next session starts clean. */
func TestAISwitchOffDuringTheSessionBlocksItEvenIfTurnedBackOn(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	recapHost(t, h)
	wb := h.newWebinar("Off then on again", nil)

	// Off before the session starts is not "during": a session started with AI on is clean.
	h.patchAI(wb.ID, false)
	h.patchAI(wb.ID, true)
	h.goLive(wb.ID)
	if got := mustWebinar(t, h, wb.ID); got.Controls.AIOffThisSession {
		t.Fatal("a session started with AI on begins marked off")
	}

	h.caption(wb.ID, "user_x", "a line said while AI was briefly off")
	h.question(wb.ID, "oo1", "Is this summarised?", 1)
	h.patchAI(wb.ID, false)
	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("ai back on: %d %s", res.StatusCode, raw)
	}
	if got := mustWebinar(t, h, wb.ID); !got.Controls.AIEnabled || !got.Controls.AIOffThisSession {
		t.Fatalf("controls after off/on = %+v, want AI on but marked off this session", got.Controls)
	}
	h.endSession(wb.ID)
	h.runRecaps()
	if got := h.getRecap(wb.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonAISessionOff {
		t.Fatalf("recap = %+v, want skipped ai_session_off", got)
	}
	if model.callCount() != 0 {
		t.Fatalf("model calls = %d, want none", model.callCount())
	}

	// The next live session starts clean.
	h.goLive(wb.ID)
	if got := mustWebinar(t, h, wb.ID); got.Controls.AIOffThisSession {
		t.Fatal("the flag survived into the next session")
	}
}

func mustWebinar(t *testing.T, h *harness, slug string) types.Webinar {
	t.Helper()
	wb, err := h.store.WebinarBySlug(context.Background(), slug)
	if err != nil {
		t.Fatal(err)
	}
	return wb
}

/* The room's AI state reaches every browser in room metadata, and the web decides whether the
 * host gets the Q&A assistant from it alone (web/lib/qa-clusters.ts qaAssistOn). So every
 * write of it carries aiAvailable and aiEnabled — after a controls PATCH, a stage promotion
 * and the AI switch — and, once AI was off during the live session, aiOffThisSession, which is
 * what tells the room the assistant is gone for the rest of the session (instant-webinar-4277,
 * 2026-10-22: AI off then on within a second; the switch read on, the assistant vanished). */
func TestRoomMetadataAlwaysCarriesTheAIState(t *testing.T) {
	h := newHarness(t)
	email := "aimeta-host@test.dev"
	h.signup("AI Meta Host", email, true)
	enableAI(t, h, email)
	wb := h.liveWebinar("AI in metadata", nil)
	room := "webinar_" + wb.ID

	check := func(step string, wantEnabled, wantOff bool) {
		t.Helper()
		h.rooms.mu.Lock()
		raw := h.rooms.metadata[room]
		h.rooms.mu.Unlock()
		for _, key := range []string{`"aiAvailable":true`, `"aiEnabled":`} {
			if !strings.Contains(raw, key) {
				t.Fatalf("%s: room metadata lacks %s: %s", step, key, raw)
			}
		}
		c := h.rooms.roomMeta(t, room).Controls
		if !c.AIAvailable || c.AIEnabled != wantEnabled || c.AIOffThisSession != wantOff {
			t.Fatalf("%s: metadata controls = %+v, want aiEnabled %v aiOffThisSession %v",
				step, c, wantEnabled, wantOff)
		}
	}

	// A controls PATCH that is not about AI.
	chat := false
	if res, raw := h.do(http.MethodPatch, "/api/host/webinars/"+wb.ID+"/controls",
		types.ControlsPatch{ChatEnabled: &chat}); res.StatusCode != http.StatusOK {
		t.Fatalf("chat off: %d %s", res.StatusCode, raw)
	}
	check("chat off", true, false)

	// Bringing an attendee on stage, and their rejoin as a panelist.
	reg := h.registerAsGuest(wb.ID, "aimeta-guest@test.dev")
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/att_"+reg.JoinKey+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("promote: %d %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, reg.JoinKey)
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/join",
		types.JoinRequest{JoinKey: reg.JoinKey}); res.StatusCode != http.StatusOK {
		t.Fatalf("rejoin: %d %s", res.StatusCode, raw)
	}
	check("stage promote", true, false)

	// The AI switch: off, then back on. The session stays out of AI and the metadata says so.
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("ai off: %d %s", res.StatusCode, raw)
	}
	check("ai off", false, true)
	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("ai on: %d %s", res.StatusCode, raw)
	}
	check("ai back on", true, true)
}
