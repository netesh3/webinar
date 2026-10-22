package replay

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

var t0 = time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)

func at(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }

func TestOffsetIsEventMinusRecordingStart(t *testing.T) {
	src := Source{RecordingStart: t0, Duration: 10 * time.Minute}
	cases := []struct {
		at   time.Time
		want int64
		ok   bool
	}{
		{t0, 0, true},
		{t0.Add(90*time.Second + 250*time.Millisecond), 90250, true},
		{t0.Add(-time.Second), 0, false},         // the pre-show is not in the video
		{t0.Add(10 * time.Minute), 600000, true}, // the last instant is
		{t0.Add(10*time.Minute + time.Millisecond), 0, false},
	}
	for _, c := range cases {
		got, ok := src.Offset(c.at)
		if got != c.want || ok != c.ok {
			t.Errorf("Offset(%v) = %d,%v want %d,%v", c.at.Sub(t0), got, ok, c.want, c.ok)
		}
	}
	// Unknown length: no upper bound.
	if _, ok := (Source{RecordingStart: t0}).Offset(t0.Add(5 * time.Hour)); !ok {
		t.Error("an unknown duration should not cut the timeline off")
	}
}

func TestBuildOrdersAndLinks(t *testing.T) {
	answered := at(50)
	closed := at(70)
	correct := 1
	src := Source{
		RecordingStart: t0,
		Duration:       100 * time.Second,
		Chat: []Chat{
			{ID: "c2", Identity: "att_k2", Name: "Rahul Verma", Role: types.RoleAttendee, Text: "second", At: at(30)},
			{ID: "c1", Identity: "user_h", Name: "Coach Asha", Role: types.RoleHost, Text: "welcome", At: at(5)},
			{ID: "c0", Identity: "att_k1", Name: "Early Bird", Role: types.RoleAttendee, Text: "before recording", At: at(-20)},
			{ID: "c9", Identity: "att_k1", Name: "Late", Role: types.RoleAttendee, Text: "after", At: at(200)},
		},
		Questions: []Question{
			{ID: "q1", Identity: "att_k3", Name: "Priya Sharma", Role: types.RoleAttendee, Text: "Slides?", At: at(30),
				Answered: true, Answer: "Yes, emailed", AnsweredAt: &answered},
			{ID: "q2", Identity: "att_k4", Name: "Secret Person", Role: types.RoleAttendee, Text: "Pricing?", Anonymous: true, At: at(40),
				Answered: true, Answer: "Later"}, // no answered_at: with the question
			{ID: "q3", Identity: "att_k5", Name: "Z", Role: types.RoleAttendee, Text: "late answer", At: at(90),
				Answered: true, Answer: "after the end", AnsweredAt: ptr(at(500))},
		},
		Polls: []Poll{{ID: "p1", Question: "Useful?", Quiz: true, Options: []string{"No", "Yes"}, Correct: &correct,
			ShareResults: true, Counts: []int{1, 3}, OpenedAt: at(60), ClosedAt: &closed}},
	}
	items := Build(src, nil, false)
	var got []string
	for _, it := range items {
		got = append(got, it.Kind+"@"+itoa(it.AtMs/1000))
	}
	want := []string{"chat@5", "chat@30", "question@30", "question@40", "answer@40", "answer@50", "poll@60", "poll_results@70", "question@90", "answer@100"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("order\n got %v\nwant %v", got, want)
	}
	for i, it := range items {
		if it.ID != "r"+itoa(int64(i+1)) {
			t.Errorf("item %d id %q", i, it.ID)
		}
		if it.Key != "" || it.Hidden {
			t.Errorf("audience item %d carries curation fields: %+v", i, it)
		}
	}
	// Answers and results point at their question / poll by timeline id.
	byID := map[string]types.ReplayItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	for _, it := range items {
		switch it.Kind {
		case KindAnswer:
			if byID[it.Ref].Kind != KindQuestion {
				t.Errorf("answer %s refs %q", it.ID, it.Ref)
			}
		case KindPollResults:
			if byID[it.Ref].Kind != KindPoll || it.Poll.Total != 4 || it.Poll.Correct == nil || *it.Poll.Correct != 1 {
				t.Errorf("results %+v %+v", it, it.Poll)
			}
		case KindPoll:
			if it.Poll.Correct != nil || it.Poll.Counts != nil {
				t.Error("a launched quiz must not carry its answer or tallies")
			}
		}
	}
	if items[0].Name != "Coach Asha" || items[0].Role != types.RoleHost {
		t.Errorf("host line = %+v", items[0])
	}
	if items[2].Name != "Priya S." {
		t.Errorf("question name = %q", items[2].Name)
	}
	if items[3].Name != "" || !items[3].Anonymous {
		t.Errorf("anonymous question exposes a name: %+v", items[3])
	}
}

func TestHiddenExcludedForAudienceMarkedForPreview(t *testing.T) {
	answered := at(20)
	src := Source{
		RecordingStart: t0, Duration: time.Minute,
		Chat: []Chat{{ID: "c1", Identity: "att_a", Name: "A B", Role: types.RoleAttendee, Text: "hi", At: at(1)}},
		Questions: []Question{{ID: "q1", Identity: "att_a", Name: "A B", Role: types.RoleAttendee, Text: "q", At: at(10),
			Answered: true, Answer: "a", AnsweredAt: &answered}},
	}
	hidden := map[string]bool{QuestionKey("q1"): true}
	aud := Build(src, hidden, false)
	if len(aud) != 1 || aud[0].Kind != KindChat || aud[0].ID != "r1" {
		t.Fatalf("audience = %+v (a hidden question takes its answer with it)", aud)
	}
	pre := Build(src, hidden, true)
	if len(pre) != 3 {
		t.Fatalf("preview = %+v", pre)
	}
	if pre[0].Key != "chat:c1" || pre[0].Hidden || !pre[1].Hidden || !pre[2].Hidden || pre[1].Key != "question:q1" {
		t.Errorf("preview curation fields wrong: %+v", pre)
	}
}

func TestAudienceTimelineCarriesNoIdentity(t *testing.T) {
	src := Source{RecordingStart: t0, Duration: time.Minute,
		Chat: []Chat{{ID: "chat-secret-id", Identity: "att_JOINKEY123", Name: "Priya Sharma", Role: types.RoleAttendee,
			Text: "mail me priya.sharma@example.com or +91 98765 43210", At: at(1)}}}
	raw, _ := json.Marshal(Build(src, nil, false))
	for _, leak := range []string{"chat-secret-id", "JOINKEY123", "att_", "Sharma", "example.com", "98765"} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("audience timeline leaks %q: %s", leak, raw)
		}
	}
}

func TestShortName(t *testing.T) {
	cases := map[string]string{
		"Priya Sharma":         "Priya S.",
		"  priya   sharma ":    "priya S.",
		"Priya":                "Priya",
		"Priya Lakshmi Sharma": "Priya S.",
		"":                     "Attendee",
		"priya@example.com":    "Attendee",
		"Call 9876543210":      "Attendee",
		"Ana 9":                "Ana",
		"Élodie Ünal":          "Élodie Ü.",
	}
	for in, want := range cases {
		if got := ShortName(in); got != want {
			t.Errorf("ShortName(%q) = %q want %q", in, got, want)
		}
	}
	// A promoted attendee (panelist role, attendee identity) is still shortened.
	if got := DisplayName("Priya Sharma", "att_x", types.RolePanelist); got != "Priya S." {
		t.Errorf("promoted attendee = %q", got)
	}
	if got := DisplayName("Coach Asha", "user_1", types.RolePanelist); got != "Coach Asha" {
		t.Errorf("panelist = %q", got)
	}
}

func TestScrub(t *testing.T) {
	cases := map[string]string{
		"call me on +91 98765 43210 ok":     "call me on [phone removed] ok",
		"9876543210":                        "[phone removed]",
		"098765-43210 please":               "[phone removed] please",
		"+919876543210":                     "[phone removed]",
		"(555) 123-4567 us":                 "[phone removed] us",
		"+44 20 7946 0958":                  "[phone removed]",
		"write to a.b+c@mail.example.co.in": "write to [email removed]",
		"x@y.io and 98765 43210":            "[email removed] and [phone removed]",
		// Not phone numbers.
		"starts at 10:30, costs 49,999": "starts at 10:30, costs 49,999",
		"year 2026, room 1234":          "year 2026, room 1234",
		"on 2026-10-22 we meet":         "on 2026-10-22 we meet",
		"pin 560001":                    "pin 560001",
	}
	for in, want := range cases {
		if got := Scrub(in); got != want {
			t.Errorf("Scrub(%q) = %q want %q", in, got, want)
		}
	}
}

func TestValidKey(t *testing.T) {
	for _, k := range []string{"chat:abc", "question:q1", "poll:p"} {
		if !ValidKey(k) {
			t.Errorf("%q should be valid", k)
		}
	}
	for _, k := range []string{"", "chat:", "foo:1", "c1", strings.Repeat("x", 300)} {
		if ValidKey(k) {
			t.Errorf("%q should be invalid", k)
		}
	}
}

func ptr[T any](v T) *T { return &v }

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
