package api_test

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* Pause and resume of the room's AI switch (decided 2026-10-22, migration 0143): off while live
 * pauses AI, on resumes it, and everything said, asked or chatted while paused stays out of
 * every AI input. Switching it while not live opens no window. */

type aiWindow struct {
	off time.Time
	on  *time.Time
}

func aiWindows(t *testing.T, h *harness, slug string) []aiWindow {
	t.Helper()
	rows, err := h.store.Pool().Query(context.Background(), `
		SELECT i.off_at, i.on_at FROM session_ai_off_intervals i JOIN webinars w ON w.id = i.webinar_id
		 WHERE w.slug = $1 ORDER BY i.off_at, i.id`, slug)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []aiWindow
	for rows.Next() {
		var w aiWindow
		if err := rows.Scan(&w.off, &w.on); err != nil {
			t.Fatal(err)
		}
		out = append(out, w)
	}
	return out
}

// sameSecond is t against an API timestamp (RFC 3339, to the second).
func sameSecond(t time.Time, api string) bool {
	at, err := time.Parse(time.RFC3339, api)
	return err == nil && t.Truncate(time.Second).Equal(at)
}

func (h *harness) chatAs(slug, id, identity, text string) {
	h.t.Helper()
	if _, err := h.store.AppendChat(context.Background(), store.ChatEntry{
		ID: id, Slug: slug, SenderID: identity, SenderName: "Asha", SenderRole: types.RoleAttendee,
		Type: types.ChatText, Destination: types.ChatToEveryone, Content: text,
	}); err != nil {
		h.t.Fatal(err)
	}
}

func TestAIResumeLeavesEveryPauseOutOfTheRecap(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	recapHost(t, h)
	wb := h.newWebinar("Paused twice", nil)

	// Not live: the switch is only set, no window.
	h.patchAI(wb.ID, false)
	h.patchAI(wb.ID, true)
	h.goLive(wb.ID)
	if n := len(aiWindows(t, h, wb.ID)); n != 0 {
		t.Fatalf("windows from toggles before the session = %d, want 0", n)
	}

	h.caption(wb.ID, "user_x", "said before any pause")
	h.question(wb.ID, "rq1", "Asked before any pause?", 1)
	h.chatAs(wb.ID, "chat-before-01", "att_a", "chatted before any pause")

	// First pause.
	if res, raw := h.patchAI(wb.ID, false); res.StatusCode != http.StatusOK {
		t.Fatalf("pause: %d %s", res.StatusCode, raw)
	}
	if c := mustWebinar(t, h, wb.ID).Controls; c.AIEnabled || !c.AIOffThisSession {
		t.Fatalf("controls while paused = %+v, want off and paused", c)
	}
	h.caption(wb.ID, "user_x", "said during the first pause")
	h.question(wb.ID, "rq2", "Asked during the first pause?", 5)
	h.chatAs(wb.ID, "chat-paused-01", "att_a", "chatted during the first pause")
	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("resume: %d %s", res.StatusCode, raw)
	}
	if c := mustWebinar(t, h, wb.ID).Controls; !c.AIEnabled || c.AIOffThisSession {
		t.Fatalf("controls after resume = %+v, want on and not paused", c)
	}
	h.caption(wb.ID, "user_x", "said between the pauses")

	// Second pause, resumed too.
	h.patchAI(wb.ID, false)
	h.caption(wb.ID, "user_x", "said during the second pause")
	h.patchAI(wb.ID, true)
	h.caption(wb.ID, "user_x", "said after both pauses")

	ws := aiWindows(t, h, wb.ID)
	if len(ws) != 2 || ws[0].on == nil || ws[1].on == nil {
		t.Fatalf("windows = %+v, want two closed", ws)
	}

	h.endSession(wb.ID)
	h.runRecaps()
	got := h.getRecap(wb.ID)
	if got.Status != types.RecapReady {
		t.Fatalf("recap = %+v, want ready", got)
	}
	if got.AIPausedMin < 1 {
		t.Fatalf("aiPausedMin = %d, want at least 1", got.AIPausedMin)
	}
	msg := userMessage(model.lastBodyFor("session_recap"))
	for _, want := range []string{"said before any pause", "said between the pauses", "said after both pauses", "Asked before any pause?", "chatted before any pause"} {
		if !strings.Contains(msg, want) {
			t.Errorf("recap input lacks %q: %s", want, msg)
		}
	}
	// Opening the recap ran the answered-aloud harvest, from the same transcript and questions.
	harvest := userMessage(model.lastBodyFor("qa_harvest"))
	if !strings.Contains(harvest, "said before any pause") {
		t.Errorf("harvest input lacks the unpaused transcript: %s", harvest)
	}
	for _, never := range []string{"first pause", "second pause"} {
		if strings.Contains(msg, never) {
			t.Errorf("recap input has %q: %s", never, msg)
		}
		if strings.Contains(harvest, never) {
			t.Errorf("harvest input has %q: %s", never, harvest)
		}
	}
}

func TestAIEndWhilePausedClosesTheWindowAtTheEnd(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	recapHost(t, h)
	wb := h.newWebinar("Ended paused", nil)
	h.goLive(wb.ID)
	h.caption(wb.ID, "user_x", "a line")
	h.patchAI(wb.ID, false)
	h.endSession(wb.ID)

	ws := aiWindows(t, h, wb.ID)
	ended := mustWebinar(t, h, wb.ID)
	if len(ws) != 1 || ws[0].on == nil || !sameSecond(*ws[0].on, ended.EndedAt) {
		t.Fatalf("windows = %+v, want one closed at the end (%s)", ws, ended.EndedAt)
	}
	if ended.Controls.AIOffThisSession {
		t.Fatal("an ended session still reads paused")
	}
	// Off at the end is still no recap.
	h.runRecaps()
	if got := h.getRecap(wb.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonAISessionOff {
		t.Fatalf("recap = %+v, want skipped ai_session_off", got)
	}
	if model.callCount() != 0 {
		t.Fatalf("model calls = %d", model.callCount())
	}

	// Going live with AI off starts paused; the next on resumes it.
	h.goLive(wb.ID)
	if c := mustWebinar(t, h, wb.ID).Controls; !c.AIOffThisSession {
		t.Fatalf("live with AI off = %+v, want paused", c)
	}
	if ws := aiWindows(t, h, wb.ID); len(ws) != 2 || ws[1].on != nil {
		t.Fatalf("windows after going live with AI off = %+v, want a second, open", ws)
	}
	h.patchAI(wb.ID, true)
	if ws := aiWindows(t, h, wb.ID); ws[1].on == nil {
		t.Fatal("resume did not close the window")
	}
}

/* A session live when 0143 shipped, latched off by 0133: the backfill opens a window from its
 * start, so resuming is allowed and everything before the resume stays out. */
func TestAILegacyLatchedSessionResumesWithEverythingBeforeLeftOut(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	recapHost(t, h)
	wb := h.newWebinar("Latched before the change", nil)
	h.goLive(wb.ID)
	h.caption(wb.ID, "user_x", "said under the old latch")
	// The state 0133 left: switched back on, but latched.
	h.exec(`UPDATE webinars SET ai_off_this_session = true, ai_enabled = true WHERE slug = $1`, wb.ID)

	raw, err := os.ReadFile("../store/migrations/0143_session_ai_off_intervals.sql")
	if err != nil {
		t.Fatal(err)
	}
	backfill := string(raw)
	i := strings.Index(backfill, "-- A session live right now")
	if i < 0 {
		t.Fatal("backfill not found in 0143")
	}
	h.exec(backfill[i:])

	got := mustWebinar(t, h, wb.ID)
	if got.Controls.AIEnabled || !got.Controls.AIOffThisSession {
		t.Fatalf("legacy controls after backfill = %+v, want off and paused", got.Controls)
	}
	ws := aiWindows(t, h, wb.ID)
	if len(ws) != 1 || ws[0].on != nil || !sameSecond(ws[0].off, got.StartedAt) {
		t.Fatalf("windows = %+v, want one open from the start %s", ws, got.StartedAt)
	}

	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("resume: %d %s", res.StatusCode, raw)
	}
	h.caption(wb.ID, "user_x", "said after the resume")
	h.endSession(wb.ID)
	h.runRecaps()
	if r := h.getRecap(wb.ID); r.Status != types.RecapReady {
		t.Fatalf("recap = %+v, want ready", r)
	}
	msg := userMessage(model.lastBodyFor("session_recap"))
	if !strings.Contains(msg, "said after the resume") || strings.Contains(msg, "under the old latch") {
		t.Fatalf("recap input = %s", msg)
	}
}

/* The after-session transcript: the agent leaves on a pause (posting what it had) and comes
 * back on resume. The recap waits for the one posted at the end and reads both, merged. */
func TestRecapWaitsForTheFinalTranscriptAfterAPause(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	ctx := context.Background()
	host := recapHost(t, h)
	wb := h.newWebinar("Agent left and came back", nil)
	h.goLive(wb.ID)
	_ = h.store.SetServerCaptions(ctx, wb.ID, true)
	before := time.Now().Add(-time.Second).UnixMilli()
	if err := h.store.SaveSessionTranscript(ctx, wb.ID, "large-v3", []store.TranscriptSegment{
		{Identity: "user_" + host.ID, Name: "Priya", Start: before, End: before + 500, Text: "heard before the pause"},
	}); err != nil {
		t.Fatal(err)
	}
	h.patchAI(wb.ID, false)
	paused := time.Now().UnixMilli()
	h.patchAI(wb.ID, true)
	_ = h.store.SetServerCaptions(ctx, wb.ID, true) // dispatched again on resume
	after := time.Now().Add(time.Second).UnixMilli()
	h.endSession(wb.ID)

	h.runRecaps()
	if model.callCount() != 0 {
		t.Fatal("the recap used the mid-session transcript without waiting for the final one")
	}
	if err := h.store.SaveSessionTranscript(ctx, wb.ID, "large-v3", []store.TranscriptSegment{
		{Identity: "user_" + host.ID, Name: "Priya", Start: paused, End: paused + 1, Text: "heard while paused"},
		{Identity: "user_" + host.ID, Name: "Priya", Start: after, End: after + 500, Text: "heard after the resume"},
	}); err != nil {
		t.Fatal(err)
	}
	_ = h.store.NudgeRecap(ctx, wb.ID)
	h.runRecaps()
	msg := userMessage(model.lastBodyFor("session_recap"))
	if !strings.Contains(msg, "heard before the pause") || !strings.Contains(msg, "heard after the resume") || strings.Contains(msg, "heard while paused") {
		t.Fatalf("recap input = %s", msg)
	}
}

func TestAIResumeQAAssistLeavesPausedQuestionsOut(t *testing.T) {
	h, model, wb, g := qaSetup(t, feeClusters, nil)
	h.ask(wb.ID, g[0], "q-pre-0001", "What is the fee before the pause?")
	h.patchAI(wb.ID, false)
	h.ask(wb.ID, g[1], "q-off-0001", "Paused question one?")
	h.ask(wb.ID, g[2], "q-off-0002", "Paused question two?")
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls while paused = %d", n)
	}
	if res, raw := h.patchAI(wb.ID, true); res.StatusCode != http.StatusOK {
		t.Fatalf("resume: %d %s", res.StatusCode, raw)
	}
	// The two paused questions do not count towards a pass.
	h.ask(wb.ID, g[1], "q-post-001", "How much does the course cost?")
	if n := model.callCount(); n != 0 {
		t.Fatalf("calls after one question since the resume = %d, want 0 (paused ones not counted)", n)
	}
	h.ask(wb.ID, g[2], "q-post-002", "Course price after the resume?")
	if n := model.callCount(); n != 1 {
		t.Fatalf("calls = %d, want one pass", n)
	}
	prompt := model.userPrompt(0)
	if !strings.Contains(prompt, "before the pause") || !strings.Contains(prompt, "after the resume") || strings.Contains(prompt, "Paused question") {
		t.Fatalf("pass input = %s", prompt)
	}
	out := h.qaClusters(wb.ID)
	if !out.Enabled {
		t.Fatalf("assistant after resume = %+v, want enabled", out)
	}
	// A paused question gets no suggested answer.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/qa/clusters/q_q-off-0001/suggest", nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("suggest for a paused question: %d %s", res.StatusCode, raw)
	}
}

func TestAIResumeLeadReasonsLeaveThePauseOut(t *testing.T) {
	h, model := aiHarness(t, leadsReply, nil)
	wb, regs := leadsWebinar(t, h, true)
	// A pause around keen's second question and one around their chat line.
	h.exec(`UPDATE session_questions SET created_at = created_at - interval '1 minute' WHERE id = 'lqa'`)
	h.exec(`INSERT INTO session_ai_off_intervals (webinar_id, off_at, on_at)
		SELECT webinar_id, created_at, created_at + interval '1 millisecond'
		  FROM session_questions WHERE id = 'lqb'`)
	h.exec(`INSERT INTO session_ai_off_intervals (webinar_id, off_at, on_at)
		SELECT webinar_id, created_at - interval '1 millisecond', created_at + interval '1 millisecond'
		  FROM chat_messages WHERE id = 'chat-000001'`)

	got := h.getLeads(wb.ID)
	if got.AIStatus != types.AIStatusReady {
		t.Fatalf("leads = %+v", got)
	}
	if got.AIPausedMin < 1 {
		t.Fatalf("aiPausedMin = %d", got.AIPausedMin)
	}
	// The ranking still counts everything.
	keen := leadByEmail(got.Leads, regs[0].Email)
	if keen.Signals.Questions != 2 || keen.Signals.Chats != 1 {
		t.Fatalf("keen's counts = %+v, want 2 questions and 1 chat", keen.Signals)
	}
	msg := userMessage(model.lastBodyFor("lead_reasons"))
	if !strings.Contains(msg, "What does the 1:1 plan cost?") || strings.Contains(msg, "EMI option for the plan") || strings.Contains(msg, "this is great") {
		t.Fatalf("reasons input = %s", msg)
	}
}
