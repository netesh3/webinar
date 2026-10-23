package highlights

import (
	"strings"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/captionvtt"
	"github.com/netkumar/webcast/api/types"
)

var t0 = time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)

func sec(s float64) time.Time { return t0.Add(time.Duration(s * float64(time.Second))) }

// Two takes: 0–300 s of the session, then (after a break) 400–700 s, which plays from 300 s.
func twoTakes() []captionvtt.Span {
	return captionvtt.Spans([]captionvtt.Take{
		{Start: sec(0), Duration: 300 * time.Second},
		{Start: sec(400), Duration: 300 * time.Second},
	})
}

func TestEventsArePlacedOnThePlayerTimeline(t *testing.T) {
	spans := twoTakes()
	ms := Moments(spans, []Event{
		{At: sec(450), Kind: KindChat, N: 1},
		{At: sec(10), Kind: KindReaction, N: 4},
		{At: sec(350), Kind: KindChat, N: 1}, // the break: in no take
		{At: sec(20), Kind: KindPoll, N: 0},  // nothing
	})
	if len(ms) != 2 || ms[0].Sec != 10 || ms[1].Sec != 350 {
		t.Fatalf("moments = %+v", ms)
	}
	parts := Parts(spans, []string{"a", "b"})
	if len(parts) != 2 || parts[1].StartSec != 300 || parts[1].EndSec != 600 || parts[1].ID != "b" {
		t.Fatalf("parts = %+v", parts)
	}
}

func TestSentencesSplitALineInProportion(t *testing.T) {
	got := Sentences([]Sentence{{StartSec: 10, EndSec: 20, Speaker: "Priya", Text: "Pay yourself first. Then  the rest! e.g. rent"}})
	if len(got) != 2 || got[0].Text != "Pay yourself first." || got[1].Text != "Then the rest! e.g. rent" {
		t.Fatalf("sentences = %+v", got)
	}
	if got[0].StartSec != 10 || got[1].EndSec != 20 || got[0].EndSec != got[1].StartSec {
		t.Fatalf("times = %+v", got)
	}
	// A line with no end gets a guessed one.
	if g := Sentences([]Sentence{{StartSec: 5, Text: "Hello there everyone"}}); len(g) != 1 || g[0].EndSec <= 5 {
		t.Fatalf("no end = %+v", g)
	}
}

// sentencesEvery is one 8-second sentence after another from start to end.
func sentencesEvery(start, end float64) []Sentence {
	var out []Sentence
	for s := start; s+8 <= end; s += 8 {
		out = append(out, Sentence{StartSec: s, EndSec: s + 8, Text: "Line at " + strings.Repeat("x", 3)})
	}
	return out
}

func TestSnapKeepsAClipOnSentencesWithinBoundsAndOneTake(t *testing.T) {
	parts := Parts(twoTakes(), []string{"a", "b"})
	ss := sentencesEvery(0, 600)

	// Mid-sentence start and end: out to the sentence edges.
	s, e, p, ok := Snap(43, 75, ss, parts)
	if !ok || p.ID != "a" || s != 39.7 || e != 80.5 {
		t.Fatalf("snap = %v %v %v %v", s, e, p, ok)
	}
	// Too short: lengthened to at least 20 s.
	s, e, _, ok = Snap(100, 104, ss, parts)
	if !ok || e-s < types.HighlightMinSec {
		t.Fatalf("short = %v–%v", s, e)
	}
	// Too long: shortened to at most 90 s.
	s, e, _, ok = Snap(100, 260, ss, parts)
	if !ok || e-s > types.HighlightMaxSec+1 {
		t.Fatalf("long = %v–%v", s, e)
	}
	// Running into the next take: cut at the take's end, never across it.
	s, e, p, ok = Snap(250, 340, ss, parts)
	if !ok || p.ID != "a" || e > 300 {
		t.Fatalf("across takes = %v–%v in %s", s, e, p.ID)
	}
	// Past the recording: nothing.
	if _, _, _, ok := Snap(900, 930, ss, parts); ok {
		t.Fatal("snapped past the end")
	}
}

func TestPeaksFindTheLiveliestStretchesWithoutOverlap(t *testing.T) {
	var ms []Moment
	for i := 0; i < 30; i++ {
		ms = append(ms, Moment{Sec: 120 + float64(i), Kind: KindReaction, N: 2})
	}
	ms = append(ms, Moment{Sec: 400, Kind: KindQuestion, N: 3}, Moment{Sec: 402, Kind: KindChat, N: 1})
	peaks := Peaks(ms, 600, 3)
	if len(peaks) != 2 {
		t.Fatalf("peaks = %+v", peaks)
	}
	if peaks[0].StartSec > 120 || peaks[0].EndSec+Lag < 149 || peaks[0].Signals.Reactions != 60 {
		t.Fatalf("first peak = %+v", peaks[0])
	}
	if peaks[1].Signals.Questions != 1 || peaks[1].Signals.Chat != 1 {
		t.Fatalf("second peak = %+v", peaks[1])
	}
	if Peaks(nil, 600, 3) != nil {
		t.Fatal("peaks with no engagement")
	}
}

func TestRankWeighsInterestAgainstEngagementAndDropsOverlaps(t *testing.T) {
	a := Part{ID: "a", StartSec: 0, EndSec: 300}
	ms := []Moment{{Sec: 205, Kind: KindReaction, N: 40}}
	ss := sentencesEvery(0, 300)
	picks := []Pick{
		{StartSec: 10, EndSec: 40, Part: a, Title: "Liked by the model", Interest: 9},
		{StartSec: 200, EndSec: 240, Part: a, Title: "Loved by the room", Interest: 6},
		{StartSec: 205, EndSec: 235, Part: a, Title: "Same moment again", Interest: 5},
	}
	got := Rank(picks, ms, ss, 5)
	if len(got) != 2 || got[0].Title != "Loved by the room" || got[0].Signals.Reactions != 40 {
		t.Fatalf("ranked = %+v", got)
	}
	if got[0].Score != 76 || got[1].Score != 54 || got[0].PartStartSec != 200 || got[0].Quote == "" {
		t.Fatalf("scores = %d, %d; %+v", got[0].Score, got[1].Score, got[0])
	}
}
