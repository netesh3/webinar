package aiwrite

import (
	"strings"
	"testing"
)

func TestHighlightsMessagesCarryPeaksAndTimes(t *testing.T) {
	lines := []RecapLine{{AtSec: 125, Speaker: "Priya", Text: "Pay yourself first."}}
	msg := HighlightsMessages(HighlightsInput{
		Topic: "Money basics", Lines: lines, Want: 4, Part: 2, Parts: 3,
		Peaks: []HighlightPeak{{StartSec: 120, EndSec: 165, Reactions: 50, Questions: 1}},
	})[1].Content
	for _, want := range []string{"[2:05 125s] Priya: Pay yourself first.", "part 2 of 3", "50 reactions, 1 question", "up to 4 moments"} {
		if !strings.Contains(msg, want) {
			t.Errorf("prompt lacks %q:\n%s", want, msg)
		}
	}
	quiet := HighlightsMessages(HighlightsInput{Topic: "x", Lines: lines, Want: 6})[1].Content
	if !strings.Contains(quiet, "left no reactions") || strings.Contains(quiet, "part ") {
		t.Errorf("no peaks prompt:\n%s", quiet)
	}
}

func TestParseHighlightsKeepsUsableMoments(t *testing.T) {
	lines := []RecapLine{{AtSec: 10}, {AtSec: 600}}
	got, err := ParseHighlights(`{"moments": [
	  {"startSec": 100, "endSec": 90, "title": "  \"Backwards\" ", "why": "w", "interest": 14},
	  {"startSec": 900, "endSec": 930, "title": "Too late", "why": "w", "interest": 5},
	  {"startSec": 200, "endSec": 230, "title": "", "why": "w", "interest": 5},
	  {"startSec": 300, "endSec": 330, "title": "Fine", "why": "w", "interest": 0},
	  {"startSec": 400, "endSec": 430, "title": "Over the want", "why": "w", "interest": 5}
	]}`, lines, 2)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if got[0].Title != "Backwards" || got[0].EndSec != 130 || got[0].Interest != 10 || got[1].Interest != 1 {
		t.Fatalf("got %+v", got)
	}
	if _, err := ParseHighlights("nope", lines, 2); err == nil {
		t.Fatal("bad JSON accepted")
	}
}
