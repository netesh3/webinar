package engagement

import (
	"testing"

	"github.com/netkumar/webcast/api/types"
)

func TestTimelineIsChronologicalAndLabelled(t *testing.T) {
	events, truncated := Timeline(t0, Activity{
		Visits:    []Visit{visit("att_a", -2, 10), visit("att_a", 15, 30)},
		Chats:     []ChatLine{{At: at(3), Text: "hello"}},
		Questions: []Question{{At: at(20), Text: "why?"}},
		Upvotes:   []UpvoteOn{{At: at(21), Question: "why?"}},
		Votes:     []VoteOn{{At: at(5), Quiz: true, Option: "b", Correct: true}, {At: at(6), Option: "x"}},
		Events: []RawEvent{
			{Kind: "reaction", Value: "👏", At: at(7)}, {Kind: "hand_raise", At: at(22)},
			{Kind: "hand_lower", At: at(23)}, {Kind: "reaction", Value: "👏", At: at(8)},
		},
	})
	if truncated {
		t.Fatal("not truncated")
	}
	for i := 1; i < len(events); i++ {
		if events[i].AtSec < events[i-1].AtSec {
			t.Fatalf("out of order at %d", i)
		}
	}
	if events[0].Text != "Joined early (lobby)" || events[0].AtSec != -120 {
		t.Fatalf("first %+v", events[0])
	}
	var rejoined, quiz bool
	for _, e := range events {
		rejoined = rejoined || e.Text == "Rejoined"
		if e.Kind == types.EventQuiz {
			quiz = e.Correct != nil && *e.Correct
		}
	}
	if !rejoined || !quiz {
		t.Fatalf("rejoin %v quiz-correct %v", rejoined, quiz)
	}
	if got := ReactionTotals([]RawEvent{{Kind: "reaction", Value: "👏"}, {Kind: "reaction", Value: "👏"}, {Kind: "hand_raise"}}); len(got) != 1 || got[0].Count != 2 {
		t.Fatalf("totals %+v", got)
	}
}

func TestTimelineKeepsTheLatestWhenCapped(t *testing.T) {
	var ev []RawEvent
	for i := 0; i < MaxTimeline+50; i++ {
		ev = append(ev, RawEvent{Kind: "reaction", Value: "👍", At: at(float64(i) / 10)})
	}
	out, truncated := Timeline(t0, Activity{Events: ev})
	if !truncated || len(out) != MaxTimeline || out[len(out)-1].AtSec != int(float64(MaxTimeline+49)/10*60) {
		t.Fatalf("truncated %v len %d last %d", truncated, len(out), out[len(out)-1].AtSec)
	}
	spans := Spans(t0, []Visit{visit("a", 1.5, 9.2), {Identity: "a", Joined: at(12)}})
	if spans[0].FromMin != 1 || spans[0].ToMin != 10 || spans[1].ToMin != -1 {
		t.Fatalf("spans %+v", spans)
	}
}
