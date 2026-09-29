package engagement

import (
	"sort"

	"github.com/netkumar/webcast/api/types"
)

// Reactions is the closed emoji set, in display order. Mirrors the relay's allow-list.
var Reactions = []string{"👏", "👍", "❤️", "😂", "🎉", "😮"}

/* collectPolls scores polls and quizzes against the people who were in the room while
 * each one was open. A vote also counts as presence: somebody who answered was there,
 * whatever the visit log says about a reconnect at that second. */
func (r *run) collectPolls() {
	byID := map[string]int{}
	for _, pl := range r.in.Polls {
		closed := r.clk.hi
		if pl.ClosedAt != nil && pl.ClosedAt.Before(closed) {
			closed = *pl.ClosedAt
		}
		isQuiz := pl.Kind == "quiz"
		if isQuiz {
			r.usage[KeyQuiz] = true
		} else {
			r.usage[KeyPolls] = true
		}
		minute := max(0, r.clk.minute(pl.OpenedAt))
		out := types.EngagementPoll{
			ID: pl.ID, Kind: pl.Kind, Question: pl.Question, Options: pl.Options,
			Correct: pl.Correct, Votes: make([]int, len(pl.Options)), Minute: minute,
		}
		live := map[*person]bool{}
		for _, v := range r.in.Visits {
			p := r.attendee(v.Identity)
			if p == nil {
				continue
			}
			left := r.clk.hi
			if v.Left != nil {
				left = *v.Left
			}
			if !v.Joined.After(pl.OpenedAt) && !left.Before(pl.OpenedAt) {
				live[p] = true
			}
			if v.Joined.Before(closed) && left.After(pl.OpenedAt) {
				r.markPresent(p, pl.ID, isQuiz)
			}
		}
		out.LiveAtOpen = len(live)
		byID[pl.ID] = len(r.sum.Polls)
		r.sum.Polls = append(r.sum.Polls, out)
		kind := "poll"
		label := "Poll · "
		if isQuiz {
			kind, label = "quiz", "Quiz · "
		}
		r.sum.Markers = append(r.sum.Markers, types.EngagementMarker{
			Minute: minute, Kind: kind, Label: label + truncate(pl.Question, markerLabelChars),
		})
		if !isQuiz {
			r.liveAtOpen += len(live)
		}
	}

	voters := map[string]bool{}
	for _, v := range r.in.Votes {
		i, ok := byID[v.PollID]
		if !ok || !IsAttendee(v.Identity) {
			continue
		}
		voters[v.Identity] = true
		pl := &r.sum.Polls[i]
		if v.Choice >= 0 && v.Choice < len(pl.Votes) {
			pl.Votes[v.Choice]++
		}
		isQuiz := pl.Kind == "quiz"
		correct := isQuiz && pl.Correct != nil && *pl.Correct == v.Choice
		p := r.attendee(v.Identity)
		r.bump(actPoll, r.clk.minute(v.At), p)
		if isQuiz {
			r.quizVotes++
			if correct {
				r.quizCorrect++
			}
		} else {
			r.pollVotes++
		}
		if p == nil {
			continue
		}
		r.markPresent(p, v.PollID, isQuiz)
		if isQuiz {
			p.quizAnswered++
			if correct {
				p.sig.QuizCorrect++
			}
		} else {
			p.sig.PollsAnswered++
		}
	}
	r.sum.KPIs.PollVoters = len(voters)
}

func (r *run) markPresent(p *person, pollID string, quiz bool) {
	if p.pollsSeen[pollID] {
		return
	}
	p.pollsSeen[pollID] = true
	if quiz {
		p.sig.QuizPresent++
	} else {
		p.sig.PollsPresent++
	}
}

// collectEvents folds the captured reactions and hands, pre-grouped per minute.
func (r *run) collectEvents() {
	r.emoji = map[string]*types.EngagementEmojiSeries{}
	for _, e := range Reactions {
		r.emoji[e] = &types.EngagementEmojiSeries{Emoji: e, Counts: make([]int, r.reactionCols)}
	}
	for _, e := range r.in.Events {
		if !IsAttendee(e.Identity) || e.Count <= 0 {
			continue
		}
		p := r.attendee(e.Identity)
		switch e.Kind {
		case "reaction":
			r.bumpN(actReaction, e.Minute, p, e.Count)
			r.sum.KPIs.Reactions += e.Count
			if p != nil {
				p.sig.Reactions += e.Count
			}
			if s := r.emoji[e.Value]; s != nil {
				s.Total += e.Count
				if i := floorDiv(e.Minute, r.sum.Reactions.BucketMin); e.Minute >= 0 && i < len(s.Counts) {
					s.Counts[i] += e.Count
				}
			}
		case "hand_raise":
			r.bumpN(actQA, e.Minute, p, e.Count)
			r.sum.KPIs.HandRaises += e.Count
			if p != nil {
				p.sig.Hands += e.Count
			}
		}
	}
	r.usage[KeyReactions] = r.sum.KPIs.Reactions > 0
	r.usage[KeyHands] = r.sum.KPIs.HandRaises > 0
	for _, e := range Reactions {
		r.sum.Reactions.Series = append(r.sum.Reactions.Series, *r.emoji[e])
	}
}

func sortBy[T any](xs []T, less func(a, b T) bool) {
	sort.SliceStable(xs, func(i, j int) bool { return less(xs[i], xs[j]) })
}

func types_count(label string, n int) types.EngagementCount {
	return types.EngagementCount{Label: label, Count: n}
}

func chatLine(minute int, name, text string) types.EngagementChatLine {
	return types.EngagementChatLine{Minute: minute, Name: name, Text: text}
}

func question(q Question, minute int, name string) types.EngagementQuestion {
	return types.EngagementQuestion{
		ID: q.ID, Minute: minute, Name: name, Text: q.Text, Upvotes: q.Upvotes, Answered: q.Answered,
	}
}
