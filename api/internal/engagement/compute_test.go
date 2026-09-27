package engagement

import (
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

var t0 = time.Date(2026, 9, 22, 13, 0, 0, 0, time.UTC)

func at(min float64) time.Time { return t0.Add(time.Duration(min * float64(time.Minute))) }
func ptr[T any](v T) *T        { return &v }

func visit(id string, from, to float64) Visit {
	return Visit{Identity: id, Joined: at(from), Left: ptr(at(to))}
}

func scenario() Input {
	return Input{
		Now: at(90),
		Webinar: Webinar{Slug: "s", Title: "T", Status: "ended",
			StartedAt: ptr(t0), EndedAt: ptr(at(60))},
		Registered: 4,
		People: []Person{
			{Identity: "att_a", Name: "Ann", RegistrationID: "r1"},
			{Identity: "att_b", Name: "Bob", RegistrationID: "r2"},
			{Identity: "att_c", Name: "Cy", RegistrationID: "r3"},
			{Identity: "user_host", Name: "Host"},
		},
		Visits: []Visit{
			visit("att_a", -5, 60),
			visit("att_b", 2, 20), visit("att_b", 30, 45),
			visit("att_c", 10, 15),
			visit("user_host", -10, 60),
		},
		Chats: []Chat{
			{Identity: "att_a", At: at(1), Length: 10, Hash: 1},
			{Identity: "att_a", At: at(1.05), Length: 10, Hash: 1},
			{Identity: "att_a", At: at(3), Length: 1, Hash: 2},
			{Identity: "att_b", At: at(4), Length: 8, Hash: 3},
			{Identity: "user_host", At: at(4), Length: 8, Hash: 4},
		},
		Questions: []Question{
			{ID: "q1", Identity: "att_a", Name: "Ann", Text: "Why?", At: at(40), Upvotes: 2},
			{ID: "q2", Identity: "att_b", Name: "Bob", Text: "Secret", At: at(41), Anonymous: true, Answered: true},
			{ID: "q3", Identity: "att_c", Name: "Cy", Text: "Spam", At: at(12), Dismissed: true},
		},
		Upvotes: []Upvote{{Identity: "att_b", At: at(42)}, {Identity: "att_c", At: at(13)}},
		Polls: []Poll{
			{ID: "p1", Kind: "poll", Question: "Pick", Options: []string{"x", "y"}, OpenedAt: at(8), ClosedAt: ptr(at(9))},
			{ID: "z1", Kind: "quiz", Question: "Right?", Options: []string{"a", "b"}, Correct: ptr(1), OpenedAt: at(50), ClosedAt: ptr(at(51))},
		},
		Votes: []Vote{
			{PollID: "p1", Identity: "att_a", Choice: 0, At: at(8.5)},
			{PollID: "z1", Identity: "att_a", Choice: 0, At: at(50.5)},
		},
		Events: []EventCount{
			{Identity: "att_a", Kind: "reaction", Value: "👏", Minute: 55, Count: 3},
			{Identity: "att_b", Kind: "hand_raise", Minute: 33, Count: 1},
			{Identity: "user_host", Kind: "reaction", Value: "🎉", Minute: 5, Count: 9},
		},
	}
}

func rowOf(t *testing.T, res Result, id string) types.EngagementAttendeeRow {
	t.Helper()
	for _, s := range res.Rows {
		if s.Row.Identity == id {
			return s.Row
		}
	}
	t.Fatalf("no row for %s", id)
	return types.EngagementAttendeeRow{}
}

func TestComputeHeadlineFigures(t *testing.T) {
	res := Compute(scenario(), Current())
	s := res.Summary
	if s.State != types.EngagementReady {
		t.Fatalf("state %s", s.State)
	}
	if len(res.Rows) != 3 {
		t.Fatalf("%d rows; the host must be excluded", len(res.Rows))
	}
	k := s.KPIs
	if k.Attended != 3 || k.Registered != 4 || k.NoShows != 1 || s.Tiers.NoShow != 1 {
		t.Fatalf("attendance %+v", k)
	}
	if k.ChatMessages != 4 || k.Chatters != 2 {
		t.Fatalf("chat %d from %d; host lines excluded", k.ChatMessages, k.Chatters)
	}
	if k.Questions != 2 || k.AnsweredQuestions != 1 {
		t.Fatalf("questions %d/%d; dismissed excluded", k.Questions, k.AnsweredQuestions)
	}
	if k.Reactions != 3 || k.HandRaises != 1 {
		t.Fatalf("reactions %d hands %d; stage reactions excluded", k.Reactions, k.HandRaises)
	}
	if k.PeakLive != 3 || k.PeakMinute != 10 {
		t.Fatalf("peak %d at %d", k.PeakLive, k.PeakMinute)
	}
	if k.PollResponsePct != 50 || k.QuizAccuracyPct != 0 {
		t.Fatalf("poll %d%% quiz %d%%", k.PollResponsePct, k.QuizAccuracyPct)
	}
	if s.Webinar.SessionMin != 60 || s.Axis.LobbyColumns != 2 || s.Axis.StartMin != -10 {
		t.Fatalf("axis %+v session %d", s.Axis, s.Webinar.SessionMin)
	}
	if s.JoinSplit.Early != 1 || s.JoinSplit.OnTime != 1 || s.JoinSplit.Late != 1 {
		t.Fatalf("join split %+v", s.JoinSplit)
	}
	if len(s.Markers) != 2 || s.Markers[0].Kind != "poll" {
		t.Fatalf("markers %+v", s.Markers)
	}
	if s.Callouts.NeedsRecap == nil || s.Callouts.NeedsRecap.PollID != "z1" {
		t.Fatalf("recap %+v", s.Callouts.NeedsRecap)
	}
}

func TestComputePerAttendeeSignals(t *testing.T) {
	res := Compute(scenario(), Current())
	a := rowOf(t, res, "att_a")
	if a.WatchMin != 60 || a.JoinTiming != types.JoinEarly || a.FirstJoinMin != -5 {
		t.Fatalf("ann watch %d timing %s first %d", a.WatchMin, a.JoinTiming, a.FirstJoinMin)
	}
	if a.Counts.Chats != 1 {
		t.Fatalf("ann chats %d: duplicate within 10s and a 1-char line earn nothing", a.Counts.Chats)
	}
	if a.Counts.Polls != 1 || a.Counts.QuizAnswered != 1 || a.Counts.QuizCorrect != 0 || a.Counts.QuizPresent != 1 {
		t.Fatalf("ann polls %+v", a.Counts)
	}

	b := rowOf(t, res, "att_b")
	if b.Visits != 2 || b.WatchMin != 33 {
		t.Fatalf("bob visits %d watch %d", b.Visits, b.WatchMin)
	}
	if b.Counts.Questions != 0 {
		t.Fatal("an anonymous question must not be attributed")
	}
	if b.Counts.PollsPresent != 1 || b.Counts.Polls != 0 || b.Counts.QuizPresent != 0 {
		t.Fatalf("bob present for p1 only: %+v", b.Counts)
	}

	c := rowOf(t, res, "att_c")
	if c.Counts.Questions != 0 || c.Counts.Upvotes != 1 || c.Counts.PollsPresent != 0 {
		t.Fatalf("cy %+v", c.Counts)
	}
	if res.Rows[0].Row.Identity != "att_a" {
		t.Fatal("rows are ordered by first arrival")
	}
	for _, r := range res.Rows {
		if len(r.Row.Presence) != res.Summary.Axis.Columns || len(r.Row.Intensity) != res.Summary.Axis.Columns {
			t.Fatalf("%s row width does not match the axis", r.Row.Identity)
		}
	}
	if a.Presence[0] != 0 || a.Presence[1] != 100 || a.Presence[2] != 100 {
		t.Fatalf("ann presence %v", a.Presence[:3])
	}
}

func TestRejoinIsCountedOncePerMinute(t *testing.T) {
	in := scenario()
	in.Visits = []Visit{visit("att_a", 0, 10.2), visit("att_a", 10.5, 20)}
	res := Compute(in, Current())
	for _, p := range res.Summary.Retention {
		if p.Live > 1 {
			t.Fatalf("minute %d counts %d people for one person", p.Minute, p.Live)
		}
	}
}

func TestComputeStates(t *testing.T) {
	in := scenario()
	in.Webinar.StartedAt = nil
	if s := Compute(in, Current()).Summary; s.State != types.EngagementNotStarted || s.Retention == nil {
		t.Fatalf("not started: %s", s.State)
	}
	in = scenario()
	in.Visits = []Visit{visit("user_host", 0, 60)}
	res := Compute(in, Current())
	if res.Summary.State != types.EngagementNoAudience || len(res.Rows) != 0 {
		t.Fatalf("no audience: %s", res.Summary.State)
	}
	if res.Summary.KPIs.NoShows != 4 {
		t.Fatalf("everyone registered is a no-show, got %d", res.Summary.KPIs.NoShows)
	}
}

func TestLiveWebinarUsesNowAndOpenVisits(t *testing.T) {
	in := scenario()
	in.Webinar.EndedAt = nil
	in.Webinar.Status = "live"
	in.Now = at(30)
	in.Visits = []Visit{{Identity: "att_a", Joined: at(0)}}
	res := Compute(in, Current())
	a := rowOf(t, res, "att_a")
	if res.Summary.Webinar.SessionMin != 30 || a.WatchMin != 30 || a.LastLeaveMin != -1 {
		t.Fatalf("live: session %d watch %d last %d", res.Summary.Webinar.SessionMin, a.WatchMin, a.LastLeaveMin)
	}
	if res.Summary.KPIs.StayedPastHalfPct != 100 {
		t.Fatal("someone still in the room has stayed past half")
	}
}

func TestLongSessionsStayBounded(t *testing.T) {
	in := Synthetic(SyntheticSpec{Attendees: 200, SessionMin: 8 * 60, Events: 5000, Seed: 3})
	s := Compute(in, Current()).Summary
	if s.Axis.Columns > maxAxisCols || len(s.Activity.Chat) > maxActivityCols || len(s.Retention) > maxRetentionPts {
		t.Fatalf("axis %d activity %d retention %d", s.Axis.Columns, len(s.Activity.Chat), len(s.Retention))
	}
}

func TestNiceStep(t *testing.T) {
	for _, c := range []struct{ span, max, want int }{
		{60, 120, 1}, {240, 120, 2}, {480, 120, 5}, {70, 36, 5}, {500, 36, 15}, {100000, 36, 3840},
	} {
		if got := niceStep(c.span, c.max, append(axisSteps[:0:0], activitySteps...)); c.max == 120 && got != c.want {
			t.Errorf("activity niceStep(%d) = %d, want %d", c.span, got, c.want)
		}
		if c.max == 36 {
			if got := niceStep(c.span, c.max, axisSteps); got != c.want {
				t.Errorf("axis niceStep(%d) = %d, want %d", c.span, got, c.want)
			}
		}
	}
	if floorDiv(-1, 5) != -1 || floorDiv(-5, 5) != -1 || floorDiv(4, 5) != 0 {
		t.Fatal("floorDiv must round toward negative infinity")
	}
}
