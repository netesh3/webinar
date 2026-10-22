package replay

import (
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/types"
)

func TestScheduleClosesAtOriginalCloseOrNextLaunch(t *testing.T) {
	c1 := at(90)
	correct := 0
	src := Source{RecordingStart: t0, Duration: 10 * time.Minute, Polls: []Poll{
		{ID: "late", Question: "Third?", Options: []string{"a", "b"}, OpenedAt: at(400)},                                 // never closed: the end
		{ID: "first", Question: "First?", Options: []string{"a", "b"}, OpenedAt: at(60), ClosedAt: &c1},                  // closed by hand
		{ID: "quiz", Question: "Second?", Quiz: true, Correct: &correct, Options: []string{"a", "b"}, OpenedAt: at(200)}, // closed by the next launch
		{ID: "pre", Question: "Pre-show", Options: []string{"a", "b"}, OpenedAt: at(-5)},                                 // not in the video
	}}
	s := Schedule(src)
	var got []string
	for _, p := range s {
		got = append(got, p.Key+"@"+itoa(p.OpenMs/1000)+"-"+itoa(p.CloseMs/1000))
	}
	if want := "poll:first@60-90 poll:quiz@200-400 poll:late@400-600"; strings.Join(got, " ") != want {
		t.Fatalf("schedule\n got %s\nwant %s", strings.Join(got, " "), want)
	}
	if s[1].Correct == nil || *s[1].Correct != 0 || !s[1].Quiz {
		t.Errorf("quiz answer not carried for the copy: %+v", s[1])
	}
	// Unknown length and never closed: stays open until the session ends.
	open := Schedule(Source{RecordingStart: t0, Polls: []Poll{{ID: "x", Options: []string{"a", "b"}, OpenedAt: at(1)}}})
	if open[0].CloseMs != -1 || !open[0].Open(int64(time.Hour/time.Millisecond)) {
		t.Errorf("open-ended poll: %+v", open[0])
	}
}

func TestPollActionsOpenOnceCloseOnTime(t *testing.T) {
	sched := []ScheduledPoll{
		{Key: "poll:a", OpenMs: 60_000, CloseMs: 90_000},
		{Key: "poll:b", OpenMs: 200_000, CloseMs: 260_000},
	}
	ops := func(acts []PollAction) string {
		var s []string
		for _, a := range acts {
			s = append(s, a.Op+":"+a.Poll.Key)
		}
		return strings.Join(s, " ")
	}
	cases := []struct {
		name   string
		have   map[string]string
		hidden map[string]bool
		pos    int64
		want   string
	}{
		{"before anything", nil, nil, 59_999, ""},
		{"a's moment", nil, nil, 60_000, "open:poll:a"},
		{"a already open", map[string]string{"poll:a": "open"}, nil, 70_000, ""},
		{"a's close", map[string]string{"poll:a": "open"}, nil, 90_000, "close:poll:a"},
		{"closed stays closed", map[string]string{"poll:a": "closed"}, nil, 70_000, ""},
		{"a's window missed entirely", nil, nil, 150_000, ""},
		{"a late, b due", map[string]string{"poll:a": "open"}, nil, 200_000, "close:poll:a open:poll:b"},
		{"hidden never opens", nil, map[string]bool{"poll:b": true}, 210_000, ""},
		{"hidden while open closes", map[string]string{"poll:b": "open"}, map[string]bool{"poll:b": true}, 210_000, "close:poll:b"},
	}
	for _, c := range cases {
		if got := ops(PollActions(sched, c.hidden, c.have, c.pos)); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	if n := NextBoundary(sched, 60_000); n != 90_000 {
		t.Errorf("next boundary after 60s = %d", n)
	}
	if n := NextBoundary(sched, 260_000); n != -1 {
		t.Errorf("next boundary at the end = %d", n)
	}
}

func TestReactionBursts(t *testing.T) {
	src := Source{RecordingStart: t0, Duration: time.Minute, Reactions: []ReactionBucket{
		{At: at(11), Emoji: "👏", N: 4},
		{At: at(12), Emoji: "❤️", N: 1},
		{At: at(13), Emoji: "👏", N: 2},
		{At: at(16), Emoji: "🎉", N: 1}, // the next window
		{At: at(-3), Emoji: "👏", N: 9}, // before the recording
		{At: at(61), Emoji: "👏", N: 9}, // after it
	}}
	items := Build(src, map[string]bool{"reaction:3": true}, false)
	if len(items) != 1 || items[0].Kind != KindReaction || items[0].AtMs != 11_000 {
		t.Fatalf("bursts = %+v", items)
	}
	if r := items[0].Reactions; len(r) != 2 || r[0] != (types.ReplayReaction{Emoji: "👏", Count: 6}) || r[1].Emoji != "❤️" {
		t.Errorf("burst counts = %+v", r)
	}
	pre := Build(src, map[string]bool{"reaction:3": true}, true)
	if len(pre) != 2 || pre[0].Key != "reaction:2" || !pre[1].Hidden {
		t.Errorf("preview bursts = %+v", pre)
	}
	if !ValidKey("reaction:2") {
		t.Error("reaction keys must be valid")
	}
}

func TestPageFiltersSearchesAndJumps(t *testing.T) {
	var items []types.ReplayItem
	for i := range 120 {
		kind := KindChat
		switch i % 4 {
		case 1:
			kind = KindQuestion
		case 2:
			kind = KindReaction
		case 3:
			kind = KindPoll
		}
		it := types.ReplayItem{ID: "r" + itoa(int64(i+1)), Kind: kind, AtMs: int64(i) * 1000, Key: "chat:" + itoa(int64(i)), Text: "line " + itoa(int64(i))}
		if kind == KindPoll {
			it.Poll = &types.ReplayPoll{Question: "Which pricing?", Options: []string{"A", "B"}}
		}
		items = append(items, it)
	}
	items[0].Hidden = true

	p := Page(items, "", "", -1, "", 50)
	if p.Total != 120 || len(p.Items) != 50 || p.NextCursor != "50" || p.PrevCursor != "" || p.Counts.Chat != 30 || p.Counts.Hidden != 1 {
		t.Fatalf("first page: total %d len %d next %q prev %q counts %+v", p.Total, len(p.Items), p.NextCursor, p.PrevCursor, p.Counts)
	}
	p = Page(items, "", "", -1, p.NextCursor, 50)
	if p.Offset != 50 || p.Items[0].ID != "r51" || p.PrevCursor != "0" || p.NextCursor != "100" {
		t.Fatalf("second page: %+v", p.Offset)
	}
	p = Page(items, types.ReplayFilterQA, "", -1, "", 10)
	if p.Total != 30 || p.Items[0].Kind != KindQuestion {
		t.Fatalf("qa filter: %d", p.Total)
	}
	if p = Page(items, "", "PRICING", -1, "", 10); p.Total != 30 {
		t.Fatalf("search in poll question: %d", p.Total)
	}
	if p = Page(items, "", "line 11", -1, "", 10); p.Total != 11 { // 11, 110..119
		t.Fatalf("search text: %d", p.Total)
	}
	// Jump to 1:05 among the chat: the first chat at or after 65s is item 68.
	p = Page(items, types.ReplayFilterChat, "", 65_000, "", 10)
	if p.Items[0].AtMs != 68_000 || p.PrevCursor == "" {
		t.Fatalf("jump: %+v", p.Items[0])
	}
	if p = Page(items, "", "", 999_999, "", 10); p.Offset != 119 {
		t.Fatalf("jump past the end: %d", p.Offset)
	}
	if keys := KeysMatching(items, types.ReplayFilterReactions, ""); len(keys) != 30 {
		t.Fatalf("keys: %d", len(keys))
	}
	if ValidFilter("nope") || !ValidFilter("") || !ValidFilter("polls") {
		t.Error("ValidFilter")
	}
}
