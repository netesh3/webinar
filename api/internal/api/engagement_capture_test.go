package api_test

/* Every audience channel — chat, Q&A, polls, reactions — from the relay to the dashboard and
 * both CSVs, including the two ways a real session differs from the happy path: an attendee
 * the host brought on stage (their chat is stamped "panelist" at send time, but they are still
 * an attendee), and a host who chatted when nobody in the audience did.
 *
 * Set TEST_DATABASE_URL to run; skipped otherwise, like every test in this package.
 */

import (
	"encoding/csv"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/netkumar/webcast/api/types"
)

func csvRecords(t *testing.T, raw []byte) [][]string {
	t.Helper()
	records, err := csv.NewReader(strings.NewReader(string(raw))).ReadAll()
	if err != nil {
		t.Fatalf("csv: %v\n%s", err, raw)
	}
	return records
}

func TestEngagementCapturesEveryAudienceChannel(t *testing.T) {
	h := newHarness(t)
	h.signup("Capture Host", "capture-host@test.dev", true)
	wb := h.liveWebinar("Capture", nil)
	plain := h.registerAsGuest(wb.ID, "plain@test.dev")
	staged := h.registerAsGuest(wb.ID, "staged@test.dev")
	stagedID := "att_" + staged.JoinKey

	say := func(joinKey string, req types.SendMessageRequest) {
		t.Helper()
		req.JoinKey = joinKey
		if res, raw := h.sayAsGuest(wb.ID, req); res.StatusCode != http.StatusOK {
			t.Fatalf("say %s: status %d body %s", req.Kind, res.StatusCode, raw)
		}
	}

	// The host brings one attendee on stage. From here their messages carry role panelist.
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/participants/"+stagedID+"/stage",
		types.StageRequest{Role: types.RolePanelist}); res.StatusCode != http.StatusOK {
		t.Fatalf("promote: status %d body %s", res.StatusCode, raw)
	}
	h.acceptStage(wb.ID, staged.JoinKey)

	say(plain.JoinKey, types.SendMessageRequest{Kind: types.MsgChat, ID: "chat-plain-01", Text: "=HYPERLINK(\"http://x\")"})
	say(plain.JoinKey, types.SendMessageRequest{Kind: types.MsgQuestion, ID: "q-plain-01", Text: "When is the replay?"})
	say(plain.JoinKey, types.SendMessageRequest{Kind: types.MsgReaction, Emoji: "👏"})
	say(staged.JoinKey, types.SendMessageRequest{Kind: types.MsgChat, ID: "chat-staged-1", Text: "hello from the stage"})
	say(staged.JoinKey, types.SendMessageRequest{Kind: types.MsgQuestion, ID: "q-staged-01", Text: "Can I share slides?"})
	say(staged.JoinKey, types.SendMessageRequest{Kind: types.MsgReaction, Emoji: "🎉"})

	// The host chats too. Never an audience number, but the dashboard has to say it happened.
	if res, raw := h.do(http.MethodPost, "/api/webinars/"+wb.ID+"/say",
		types.SendMessageRequest{Kind: types.MsgChat, ID: "chat-host-001", Text: "welcome everyone"}); res.StatusCode != http.StatusOK {
		t.Fatalf("host chat: status %d body %s", res.StatusCode, raw)
	}

	poll := h.createPoll(wb.ID, types.PollInput{Question: "Useful?", Kind: types.PollOpinion, Options: []string{"Yes", "No"}})
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/polls/"+poll.ID+"/open", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("open poll: status %d body %s", res.StatusCode, raw)
	}
	for _, r := range []types.Registration{plain, staged} {
		if res, raw := h.voteAsGuest(wb.ID, poll.ID, r.JoinKey, 0); res.StatusCode != http.StatusOK {
			t.Fatalf("vote: status %d body %s", res.StatusCode, raw)
		}
	}
	if err := h.server.FlushEngagement(t.Context()); err != nil {
		t.Fatal(err)
	}

	live := time.Now().UTC().Truncate(time.Minute).Add(-30 * time.Minute)
	end := live.Add(20 * time.Minute)
	ctx := t.Context()
	mustOpen(t, h, ctx, wb.ID, "att_"+plain.JoinKey, "Plain", live)
	mustClose(t, h, ctx, wb.ID, "att_"+plain.JoinKey, end)
	mustOpen(t, h, ctx, wb.ID, stagedID, "Staged", live)
	mustClose(t, h, ctx, wb.ID, stagedID, end)
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/end", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("end: status %d body %s", res.StatusCode, raw)
	}
	pinSessionWindow(t, wb.ID, live, end)
	pinEventTimes(t, wb.ID, live.Add(5*time.Minute))
	pinPollTimes(t, wb.ID, live.Add(4*time.Minute))
	if res, raw := h.do(http.MethodPost, "/api/host/webinars/"+wb.ID+"/engagement/recompute", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("recompute: status %d body %s", res.StatusCode, raw)
	}

	s := h.engagementSummary(wb.ID)
	k := s.KPIs
	if k.ChatMessages != 2 || k.Chatters != 2 {
		t.Errorf("chat %d from %d people, want 2 from 2 (the promoted attendee is still an attendee)", k.ChatMessages, k.Chatters)
	}
	if k.StageChatMessages != 1 {
		t.Errorf("stage chat %d, want the host's 1", k.StageChatMessages)
	}
	if k.Questions != 2 || k.Reactions != 2 || k.PollVoters != 2 {
		t.Errorf("questions %d reactions %d poll voters %d, want 2 each", k.Questions, k.Reactions, k.PollVoters)
	}
	sum := func(xs []int) (n int) {
		for _, x := range xs {
			n += x
		}
		return n
	}
	a := s.Activity
	if sum(a.Chat) != 2 || sum(a.QA) != 2 || sum(a.Poll) != 2 || sum(a.Reaction) != 2 {
		t.Errorf("activity chat %v qa %v poll %v reaction %v", a.Chat, a.QA, a.Poll, a.Reaction)
	}

	res, raw := h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/engagement.csv", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("engagement csv: status %d", res.StatusCode)
	}
	rows := csvRecords(t, raw)
	col := func(name string) int { return csvColumn(t, rows[0], name) }
	for _, r := range rows[1:] {
		for _, c := range []string{"chats", "questions", "polls_answered", "reactions"} {
			if r[col(c)] != "1" {
				t.Errorf("%s: %s = %q, want 1 (row %v)", r[col("email")], c, r[col(c)], r)
			}
		}
	}

	res, raw = h.do(http.MethodGet, "/api/host/webinars/"+wb.ID+"/chat?format=csv", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("chat csv: status %d body %s", res.StatusCode, raw)
	}
	log := csvRecords(t, raw)
	content := csvColumn(t, log[0], "messageContent")
	if len(log) != 4 {
		t.Fatalf("chat csv has %d lines, want header + 3 messages", len(log))
	}
	for _, r := range log[1:] {
		if strings.HasPrefix(r[content], "=") {
			t.Errorf("chat csv writes a formula verbatim: %q", r[content])
		}
	}
}

func pinPollTimes(t *testing.T, slug string, at time.Time) {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, q := range []string{
		`UPDATE polls SET opened_at = $2 WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`,
		`UPDATE poll_votes SET voted_at = $2::timestamptz + interval '30 seconds'
		  WHERE poll_id IN (SELECT p.id FROM polls p JOIN webinars w ON w.id = p.webinar_id WHERE w.slug = $1)`,
		`UPDATE session_questions SET created_at = $2 WHERE webinar_id = (SELECT id FROM webinars WHERE slug = $1)`,
	} {
		if _, err := pool.Exec(t.Context(), q, slug, at); err != nil {
			t.Fatal(err)
		}
	}
}
