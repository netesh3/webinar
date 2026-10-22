package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* The AI recap, end to end against a fake gpt-5-nano: scheduled when a session ends,
 * written by the recap lane from the best source there is, emailed to the host once and
 * to nobody else. */

const recapReply = `{
  "summary": "Priya walked through budgeting a first salary. The audience asked most about SIPs.",
  "keyPoints": ["Split your salary in three", "Start an emergency fund first", "Pick one simple SIP"],
  "actionItems": [{"text": "Share the budgeting sheet", "owner": "host"}, {"text": "Try the 50-30-20 split", "owner": "attendee"}],
  "chapters": [{"startSec": 40, "title": "Welcome"}, {"startSec": 300, "title": "The three buckets"}, {"startSec": 310, "title": "Too close"}],
  "topQuestions": [{"question": "Which SIP should I start with?", "answered": false, "upvotes": 4}],
  "notableQuotes": [{"text": "Pehle khud ko pay karo, phir baaki sab.", "speaker": "Priya"}]
}`

func init() {
	// Due the moment the session ends, so a test need not wait out the settle time.
	api.SetRecapDelay(0)
}

// recapHost signs up a host with the ai switch turned on for them and returns them.
func recapHost(t *testing.T, h *harness) types.Account {
	t.Helper()
	acct := h.signup("Priya Recap", "recap-host-"+strings.ReplaceAll(t.Name(), "/", "-")+"@test.dev", true)
	enableAIForUser(t, h, acct.ID)
	return acct
}

/* enableAIForUser turns the ai switch on for one account, as an admin does. Explicit rather than
 * relying on the tier default, because the switch is meant to be opt-in per host. */
func enableAIForUser(t *testing.T, h *harness, userID string) {
	t.Helper()
	on := true
	if _, err := h.store.SetFeatureOverride(context.Background(), userID, types.FeatureAI, &on); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) endSession(slug string) {
	h.t.Helper()
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+slug+"/end", nil); res.StatusCode != http.StatusOK {
		h.t.Fatalf("end %s: %d %s", slug, res.StatusCode, raw)
	}
}

func (h *harness) getRecap(slug string) types.SessionRecapResponse {
	h.t.Helper()
	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+slug+"/recap", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("get recap: %d %s", res.StatusCode, raw)
	}
	var out types.SessionRecapResponse
	h.decode(raw, &out)
	return out
}

type recapMail struct {
	UserID, Email, Subject, Body, HTML string
}

// recapMails is every session_recap row in the outbox for slug.
func (h *harness) recapMails(slug string) []recapMail {
	h.t.Helper()
	rows, err := h.store.Pool().Query(context.Background(), `
		SELECT COALESCE(n.user_id::text, ''), n.email, n.subject, n.body, n.html
		  FROM notifications n JOIN webinars w ON w.id = n.webinar_id
		 WHERE w.slug = $1 AND n.kind = 'session_recap' ORDER BY n.email`, slug)
	if err != nil {
		h.t.Fatal(err)
	}
	defer rows.Close()
	var out []recapMail
	for rows.Next() {
		var m recapMail
		if err := rows.Scan(&m.UserID, &m.Email, &m.Subject, &m.Body, &m.HTML); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func (h *harness) runRecaps() {
	h.t.Helper()
	api.RunRecaps(h.server, context.Background())
}

func (h *harness) caption(slug, identity, text string) {
	h.t.Helper()
	if err := h.store.AppendCaption(context.Background(), slug, identity, text); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) question(slug, id, text string, upvotes int) {
	h.t.Helper()
	ctx := context.Background()
	if err := h.store.UpsertSessionQuestion(ctx, slug, types.SessionQuestion{ID: id, Identity: "att_" + id, Name: "Asha", Text: text}); err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.store.Pool().Exec(ctx, `UPDATE session_questions SET upvotes = $2 WHERE id = $1`, id, upvotes); err != nil {
		h.t.Fatal(err)
	}
}

func userMessage(body map[string]any) string {
	msgs, _ := json.Marshal(body["messages"])
	return string(msgs)
}

func TestRecapAfterWebinarEndsEmailsTheHostOnce(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	ctx := context.Background()
	host := recapHost(t, h)
	wb := h.newWebinar("Money basics for young earners", nil)
	h.goLive(wb.ID)

	// An attendee who registered: they must get no recap.
	h.logout()
	h.registerAs(wb.ID, "attendee-recap@test.dev")
	h.login(host.Email)

	h.caption(wb.ID, "user_"+host.ID, "Namaste everyone, today we budget a first salary.")
	h.caption(wb.ID, "user_"+host.ID, "Pehle khud ko pay karo, phir baaki sab.")
	h.question(wb.ID, "q1", "Which SIP should I start with?", 4)

	if got := h.getRecap(wb.ID); got.Status != types.RecapNone || got.Reason != types.RecapReasonNotEnded {
		t.Fatalf("before the end: %+v", got)
	}
	h.endSession(wb.ID)
	if got := h.getRecap(wb.ID); got.Status != types.RecapPending {
		t.Fatalf("just ended: %+v", got)
	}

	h.runRecaps()
	if model.callCount() != 1 {
		t.Fatalf("model calls = %d, want 1", model.callCount())
	}
	body := model.lastBody()
	if body["model"] != "gpt-5-nano" || body["reasoning_effort"] != "low" {
		t.Errorf("request = %v", body)
	}
	if rf, _ := body["response_format"].(map[string]any); rf["type"] != "json_schema" {
		t.Errorf("response_format = %v", body["response_format"])
	}
	msg := userMessage(body)
	for _, want := range []string{"today we budget a first salary", "Priya Recap:", "Which SIP should I start with?", "4 upvotes"} {
		if !strings.Contains(msg, want) {
			t.Errorf("prompt is missing %q: %s", want, msg)
		}
	}

	got := h.getRecap(wb.ID)
	if got.Status != types.RecapReady || got.Source != types.RecapSourceCaptions || got.Recap == nil || got.EmailedAt == "" {
		t.Fatalf("recap = %+v", got)
	}
	r := got.Recap
	if len(r.KeyPoints) != 3 || len(r.ActionItems) != 2 || r.ActionItems[0].Owner != types.RecapOwnerHost {
		t.Errorf("recap body = %+v", r)
	}
	// Ordered, the one 10s after the last dropped, the first moved to 0.
	if len(r.Chapters) != 2 || r.Chapters[0].StartSec != 0 || r.Chapters[1].StartSec != 300 {
		t.Errorf("chapters = %+v", r.Chapters)
	}
	if r.Attendance.Registered != 1 || r.Attendance.Questions != 1 {
		t.Errorf("attendance = %+v", r.Attendance)
	}
	if r.Notice != "" {
		t.Errorf("notice on a recap with captions: %q", r.Notice)
	}

	// The host's email and the bell; nothing for the attendee.
	mails := h.recapMails(wb.ID)
	if len(mails) != 2 {
		t.Fatalf("recap rows = %+v, want the host's alert and email", mails)
	}
	alert, email := mails[0], mails[1]
	if alert.UserID != host.ID || alert.Email != "" {
		t.Errorf("alert = %+v", alert)
	}
	if email.Email != strings.ToLower(host.Email) || email.UserID != "" {
		t.Errorf("email = %+v", email)
	}
	if email.Subject != "Your AI recap: Money basics for young earners" ||
		!strings.Contains(email.Body, "Share the budgeting sheet") ||
		!strings.Contains(email.Body, "/host/"+wb.ID+"?tab=results") ||
		!strings.Contains(email.HTML, "Which SIP should I start with?") {
		t.Errorf("email = %+v", email)
	}
	var toAttendee int
	_ = h.store.Pool().QueryRow(ctx, `SELECT count(*) FROM notifications WHERE email = 'attendee-recap@test.dev' AND kind = 'session_recap'`).Scan(&toAttendee)
	if toAttendee != 0 {
		t.Fatal("an attendee was sent the recap")
	}
	// The outbox takes it although the webinar has ended: with no mail transport in the
	// tests it is marked skipped, which is what a send attempt looks like here.
	h.server.WaitBackground()
	var delivery string
	if err := h.store.Pool().QueryRow(ctx, `SELECT delivery FROM notifications WHERE email = $1 AND kind = 'session_recap'`,
		strings.ToLower(host.Email)).Scan(&delivery); err != nil || delivery != "skipped" {
		t.Errorf("recap email delivery = %q (%v), want the outbox to have taken it", delivery, err)
	}

	// Idempotent: another pass, another end, a regenerate — still one email, no new automatic call.
	h.runRecaps()
	h.goLive(wb.ID)
	h.endSession(wb.ID)
	h.runRecaps()
	if model.callCount() != 1 {
		t.Fatalf("model calls after re-runs = %d, want 1", model.callCount())
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recap", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("regenerate: %d %s", res.StatusCode, raw)
	}
	if model.callCount() != 2 {
		t.Fatalf("regenerate made %d calls in all, want 2", model.callCount())
	}
	if len(h.recapMails(wb.ID)) != 2 {
		t.Fatal("regenerate emailed again")
	}
	// Counted against the month as feature "recap".
	var calls int
	_ = h.store.Pool().QueryRow(ctx, `SELECT count(*) FROM ai_usage WHERE feature = 'recap' AND host_id = $1`, host.ID).Scan(&calls)
	if calls != 2 {
		t.Errorf("recap usage rows = %d, want 2", calls)
	}
}

func TestRecapAfterMeetingFromEngagementOnly(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	host := meetingHost(t, h)
	enableAIForUser(t, h, host.ID)
	wb := h.instantMeeting("Weekly stand-up", nil)
	h.goLive(wb.ID)
	h.question(wb.ID, "mq1", "When is the next release?", 2)
	h.endSession(wb.ID)
	h.runRecaps()

	if model.callCount() != 1 {
		t.Fatalf("model calls = %d", model.callCount())
	}
	msg := userMessage(model.lastBody())
	if !strings.Contains(msg, "(meeting)") || !strings.Contains(msg, "No transcript") {
		t.Errorf("prompt = %s", msg)
	}
	got := h.getRecap(wb.ID)
	if got.Status != types.RecapReady || got.Source != types.RecapSourceEngagementOnly {
		t.Fatalf("recap = %+v", got)
	}
	if len(got.Recap.Chapters) != 0 || len(got.Recap.NotableQuotes) != 0 || !strings.Contains(got.Recap.Notice, "Turn on captions") {
		t.Errorf("engagement-only recap = %+v", got.Recap)
	}
	mails := h.recapMails(wb.ID)
	if len(mails) != 2 || mails[1].Email != strings.ToLower(host.Email) || !strings.Contains(mails[1].Body, "Turn on captions") {
		t.Fatalf("mails = %+v", mails)
	}
}

func TestRecapWaitsForTheServerTranscript(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	ctx := context.Background()
	host := recapHost(t, h)
	wb := h.newWebinar("Transcribed session", nil)
	h.goLive(wb.ID)
	if err := h.store.SetServerCaptions(ctx, wb.ID, true); err != nil {
		t.Fatal(err)
	}
	h.caption(wb.ID, "user_"+host.ID, "live caption line")
	h.endSession(wb.ID)

	// Server captions ran: the recap waits for the after-session transcript.
	h.runRecaps()
	if model.callCount() != 0 {
		t.Fatal("the recap did not wait for the transcript")
	}
	if got := h.getRecap(wb.ID); got.Status != types.RecapPending || got.Reason != types.RecapReasonWaitingTranscript {
		t.Fatalf("waiting = %+v", got)
	}

	// It arrives (the internal endpoint does exactly this), and the recap is due at once.
	start := time.Now().Add(-time.Minute).UnixMilli()
	if err := h.store.SaveSessionTranscript(ctx, wb.ID, "large-v3", []store.TranscriptSegment{
		{Identity: "user_" + host.ID, Name: "Priya", Start: start, End: start + 4000, Text: "the large model heard this"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.store.NudgeRecap(ctx, wb.ID); err != nil {
		t.Fatal(err)
	}
	h.runRecaps()
	if model.callCount() != 1 {
		t.Fatalf("model calls = %d", model.callCount())
	}
	msg := userMessage(model.lastBody())
	if !strings.Contains(msg, "the large model heard this") || strings.Contains(msg, "live caption line") {
		t.Errorf("prompt did not prefer the transcript: %s", msg)
	}
	if got := h.getRecap(wb.ID); got.Source != types.RecapSourceServerTranscript {
		t.Fatalf("source = %q", got.Source)
	}

	// A transcript that never comes: after the wait, the captions are used.
	wb2 := h.newWebinar("Transcript lost", nil)
	h.goLive(wb2.ID)
	_ = h.store.SetServerCaptions(ctx, wb2.ID, true)
	h.caption(wb2.ID, "user_"+host.ID, "only the captions have this")
	h.endSession(wb2.ID)
	h.runRecaps()
	if model.callCount() != 1 {
		t.Fatal("did not wait")
	}
	if _, err := h.store.Pool().Exec(ctx, `
		UPDATE session_recaps r SET wait_until = now() - interval '1 second', due_at = now()
		  FROM webinars w WHERE w.id = r.webinar_id AND w.slug = $1`, wb2.ID); err != nil {
		t.Fatal(err)
	}
	h.runRecaps()
	if got := h.getRecap(wb2.ID); got.Source != types.RecapSourceCaptions ||
		!strings.Contains(userMessage(model.lastBody()), "only the captions have this") {
		t.Fatalf("after the wait: %+v", got)
	}
}

func TestRecapRespectsTheSwitchTheCapAndAnEmptySession(t *testing.T) {
	h, model := aiHarness(t, recapReply, func(c *config.Config) { c.AIHostMonthlyUSD = 0.5 })
	ctx := context.Background()
	host := recapHost(t, h)

	// Nothing happened: no call, no email.
	empty := h.newWebinar("Nobody came", nil)
	h.goLive(empty.ID)
	h.endSession(empty.ID)
	h.runRecaps()
	if got := h.getRecap(empty.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonEmpty {
		t.Fatalf("empty = %+v", got)
	}

	// The host's cap is spent: skipped, not retried, no email.
	if err := h.store.RecordAIUsage(ctx, store.AIUsage{Feature: types.AIFeatureWebinarSetup, HostID: host.ID, CostUSD: 1, OK: true}); err != nil {
		t.Fatal(err)
	}
	capped := h.newWebinar("Over the cap", nil)
	h.goLive(capped.ID)
	h.question(capped.ID, "cq1", "Is this capped?", 1)
	h.endSession(capped.ID)
	h.runRecaps()
	if got := h.getRecap(capped.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonAILimit {
		t.Fatalf("capped = %+v", got)
	}
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+capped.ID+"/recap", nil)
	if res.StatusCode != http.StatusTooManyRequests || errorCode(t, raw) != "ai_limit" {
		t.Fatalf("regenerate over the cap: %d %s", res.StatusCode, raw)
	}

	// The switch off: no call at all.
	off := false
	if _, err := h.store.SetFeatureOverride(ctx, host.ID, types.FeatureAI, &off); err != nil {
		t.Fatal(err)
	}
	dark := h.newWebinar("AI off", nil)
	h.goLive(dark.ID)
	h.question(dark.ID, "dq1", "Anyone there?", 0)
	h.endSession(dark.ID)
	h.runRecaps()
	if got := h.getRecap(dark.ID); got.Status != types.RecapSkipped || got.Reason != types.RecapReasonAIOff {
		t.Fatalf("ai off = %+v", got)
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+dark.ID+"/recap", nil)
	if res.StatusCode != http.StatusForbidden || errorCode(t, raw) != "feature_off" {
		t.Fatalf("regenerate with ai off: %d %s", res.StatusCode, raw)
	}

	if model.callCount() != 0 {
		t.Fatalf("model calls = %d, want none", model.callCount())
	}
	for _, slug := range []string{empty.ID, capped.ID, dark.ID} {
		if m := h.recapMails(slug); len(m) != 0 {
			t.Errorf("%s: mails = %+v", slug, m)
		}
	}
}

func TestRecapRegenerateGuards(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	host := recapHost(t, h)
	wb := h.newWebinar("Guarded", nil)
	h.goLive(wb.ID)
	h.question(wb.ID, "gq1", "A question", 1)

	// Not ended yet.
	res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recap", nil)
	if res.StatusCode != http.StatusConflict || errorCode(t, raw) != "not_ended" {
		t.Fatalf("live: %d %s", res.StatusCode, raw)
	}
	h.endSession(wb.ID)

	// Another host cannot read or regenerate it.
	h.logout()
	h.signup("Someone Else", "someone-else-recap@test.dev", true)
	for _, m := range []string{http.MethodGet, http.MethodPost} {
		if res, _ := h.do(m, "/api/host/webinars/"+wb.ID+"/recap", nil); res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s by another host: %d", m, res.StatusCode)
		}
	}
	h.logout()
	h.login(host.Email)

	// Three in ten minutes, then rate limited.
	for i := 0; i < 3; i++ {
		if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recap", nil); res.StatusCode != http.StatusOK {
			t.Fatalf("regenerate %d: %d %s", i, res.StatusCode, raw)
		}
	}
	res, raw = h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/recap", nil)
	if res.StatusCode != http.StatusTooManyRequests || errorCode(t, raw) != "rate_limited" {
		t.Fatalf("fourth: %d %s", res.StatusCode, raw)
	}
	if model.callCount() != 3 {
		t.Fatalf("model calls = %d, want 3", model.callCount())
	}
	// A regenerate before the lane ran made it ready; the lane neither rewrites nor mails it.
	h.runRecaps()
	if model.callCount() != 3 || len(h.recapMails(wb.ID)) != 0 {
		t.Fatalf("lane after regenerate: calls %d mails %d", model.callCount(), len(h.recapMails(wb.ID)))
	}
}

// A transcript too long for one call is summarised in parts and the notes merged.
func TestRecapChunksALongTranscript(t *testing.T) {
	h, model := aiHarness(t, recapReply, nil)
	host := recapHost(t, h)
	wb := h.newWebinar("A very long class", nil)
	h.goLive(wb.ID)
	// ~340k runes of captions: three parts at 150k.
	if _, err := h.store.Pool().Exec(context.Background(), `
		INSERT INTO session_captions (webinar_id, identity, body, at)
		SELECT w.id, 'user_' || $2, 'line ' || i || ' ' || repeat('padding words ', 10), now() + make_interval(secs => i)
		  FROM webinars w, generate_series(1, 2000) i WHERE w.slug = $1`, wb.ID, host.ID); err != nil {
		t.Fatal(err)
	}
	h.endSession(wb.ID)
	h.runRecaps()
	if n := model.callCount(); n != 4 {
		t.Fatalf("model calls = %d, want 3 parts and a merge", n)
	}
	if msg := userMessage(model.lastBody()); !strings.Contains(msg, "Part 3 notes") || strings.Contains(msg, "padding words") {
		t.Errorf("merge prompt = %.300s", msg)
	}
	if got := h.getRecap(wb.ID); got.Status != types.RecapReady || len(h.recapMails(wb.ID)) != 2 {
		t.Fatalf("recap = %+v", got)
	}
}
