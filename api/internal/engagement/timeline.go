package engagement

import (
	"math"
	"sort"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// MaxTimeline bounds the drawer's timeline; a person who reacted 3,000 times does not need
// 3,000 rows to show that they did.
const MaxTimeline = 400

type UpvoteOn struct {
	At       time.Time
	Question string
}

type VoteOn struct {
	At      time.Time
	Quiz    bool
	Option  string
	Correct bool
}

type RawEvent struct {
	Kind  string
	Value string
	At    time.Time
}

// Activity is everything one person did, as loaded for their drawer.
type Activity struct {
	Visits    []Visit
	Chats     []ChatLine
	Questions []Question
	Upvotes   []UpvoteOn
	Votes     []VoteOn
	Events    []RawEvent
}

// Timeline merges a person's activity into one chronological list, keeping the most
// recent MaxTimeline entries when there are more.
func Timeline(start time.Time, a Activity) ([]types.EngagementTimelineEvent, bool) {
	sec := func(t time.Time) int { return int(math.Floor(t.Sub(start).Seconds())) }
	out := make([]types.EngagementTimelineEvent, 0, len(a.Visits)*2+len(a.Chats)+len(a.Events))
	add := func(t time.Time, kind types.EngagementEventKind, text string) *types.EngagementTimelineEvent {
		out = append(out, types.EngagementTimelineEvent{AtSec: sec(t), Kind: kind, Text: text})
		return &out[len(out)-1]
	}

	for i, v := range a.Visits {
		label := "Joined"
		switch {
		case i > 0:
			label = "Rejoined"
		case v.Joined.Before(start):
			label = "Joined early (lobby)"
		}
		add(v.Joined, types.EventJoin, label)
		if v.Left != nil {
			add(*v.Left, types.EventLeave, "Left the room")
		}
	}
	for _, c := range a.Chats {
		add(c.At, types.EventChat, truncate(c.Text, 280))
	}
	for _, q := range a.Questions {
		add(q.At, types.EventQuestion, "Asked: “"+truncate(q.Text, 200)+"”")
	}
	for _, u := range a.Upvotes {
		add(u.At, types.EventUpvote, "Upvoted “"+truncate(u.Question, 120)+"”")
	}
	for _, v := range a.Votes {
		if v.Quiz {
			e := add(v.At, types.EventQuiz, "Quiz: "+v.Option)
			e.Correct = &v.Correct
		} else {
			add(v.At, types.EventPoll, "Poll: "+v.Option)
		}
	}
	for _, e := range a.Events {
		switch e.Kind {
		case "reaction":
			add(e.At, types.EventReaction, "Reacted "+e.Value).Emoji = e.Value
		case "hand_raise":
			add(e.At, types.EventHand, "Raised hand")
		case "hand_lower":
			add(e.At, types.EventHand, "Lowered hand")
		case "stage_on":
			add(e.At, types.EventStage, "Brought on stage")
		case "stage_off":
			add(e.At, types.EventStage, "Left the stage")
		}
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].AtSec < out[j].AtSec })
	if len(out) > MaxTimeline {
		return out[len(out)-MaxTimeline:], true
	}
	return out, false
}

// Spans is a person's visits as minute offsets; ToMin is -1 while still in the room.
func Spans(start time.Time, visits []Visit) []types.EngagementVisitSpan {
	out := make([]types.EngagementVisitSpan, 0, len(visits))
	for _, v := range visits {
		s := types.EngagementVisitSpan{FromMin: int(math.Floor(v.Joined.Sub(start).Minutes())), ToMin: -1}
		if v.Left != nil {
			s.ToMin = int(math.Ceil(v.Left.Sub(start).Minutes()))
		}
		out = append(out, s)
	}
	return out
}

// ReactionTotals counts a person's reactions per emoji, in display order.
func ReactionTotals(events []RawEvent) []types.EngagementCount {
	n := map[string]int{}
	for _, e := range events {
		if e.Kind == "reaction" {
			n[e.Value]++
		}
	}
	out := []types.EngagementCount{}
	for _, e := range Reactions {
		if n[e] > 0 {
			out = append(out, types.EngagementCount{Label: e, Count: n[e]})
		}
	}
	return out
}
