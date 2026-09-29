package engagement

import (
	"fmt"
	"math/rand/v2"
	"time"
)

type SyntheticSpec struct {
	Attendees  int
	SessionMin int
	// Events is the number of captured reactions/hands before per-minute grouping.
	Events int
	Chats  int
	Polls  int
	Seed   uint64
}

/* Synthetic builds a plausible webinar for benchmarks and load tests: early, on-time and
 * late arrivals, drop-offs and rejoins, chat and Q&A bursts, polls with votes, and raw
 * reactions grouped per minute the way the store groups them. Deterministic for a seed. */
func Synthetic(spec SyntheticSpec) Input {
	rng := rand.New(rand.NewPCG(spec.Seed, spec.Seed^0x9e3779b97f4a7c15))
	start := time.Date(2026, 9, 22, 13, 0, 0, 0, time.UTC)
	end := start.Add(time.Duration(spec.SessionMin) * time.Minute)
	minAt := func(m float64) time.Time { return start.Add(time.Duration(m * float64(time.Minute))) }
	S := float64(spec.SessionMin)

	in := Input{
		Now:        end.Add(time.Hour),
		Webinar:    Webinar{Slug: "synthetic", Title: "Synthetic", Status: "ended", StartedAt: &start, EndedAt: &end},
		Registered: spec.Attendees * 13 / 10,
		Extra:      map[string]map[string]float64{},
	}
	ids := make([]string, spec.Attendees)
	for i := range ids {
		id := fmt.Sprintf("att_%06d", i)
		ids[i] = id
		in.People = append(in.People, Person{Identity: id, Name: fmt.Sprintf("Person %d", i),
			Email: fmt.Sprintf("p%d@example.com", i), RegistrationID: fmt.Sprintf("r%d", i)})

		join := rng.Float64()*20 - 8
		stay := S * (0.2 + 0.8*rng.Float64())
		leave := min(S, join+stay)
		if rng.Float64() < 0.2 {
			gap := 2 + rng.Float64()*8
			mid := join + (leave-join)/2
			in.Visits = append(in.Visits,
				Visit{Identity: id, Joined: minAt(join), Left: ptrTime(minAt(mid))},
				Visit{Identity: id, Joined: minAt(mid + gap), Left: ptrTime(minAt(max(mid+gap, leave)))})
		} else {
			in.Visits = append(in.Visits, Visit{Identity: id, Joined: minAt(join), Left: ptrTime(minAt(leave))})
		}
	}

	chats := spec.Chats
	if chats == 0 {
		chats = spec.Attendees * 3
	}
	for i := 0; i < chats; i++ {
		in.Chats = append(in.Chats, Chat{Identity: ids[rng.IntN(len(ids))], At: minAt(rng.Float64() * S),
			Length: 2 + rng.IntN(80), Hash: int64(rng.IntN(1 << 20))})
	}
	for i := 0; i < spec.Attendees/10; i++ {
		id := ids[rng.IntN(len(ids))]
		in.Questions = append(in.Questions, Question{ID: fmt.Sprintf("q%d", i), Identity: id, Name: id,
			Text: "A question", At: minAt(rng.Float64() * S), Upvotes: rng.IntN(10), Answered: rng.IntN(2) == 0})
	}
	for i := 0; i < spec.Attendees/3; i++ {
		in.Upvotes = append(in.Upvotes, Upvote{Identity: ids[rng.IntN(len(ids))], At: minAt(rng.Float64() * S)})
	}

	polls := spec.Polls
	if polls == 0 {
		polls = 6
	}
	for p := 0; p < polls; p++ {
		open := S * float64(p+1) / float64(polls+1)
		kind := "poll"
		var correct *int
		if p%2 == 1 {
			kind, correct = "quiz", ptrInt(1)
		}
		id := fmt.Sprintf("poll%d", p)
		in.Polls = append(in.Polls, Poll{ID: id, Kind: kind, Question: "Question " + id,
			Options: []string{"a", "b", "c", "d"}, Correct: correct,
			OpenedAt: minAt(open), ClosedAt: ptrTime(minAt(open + 2))})
		for _, voter := range ids {
			if rng.Float64() < 0.55 {
				in.Votes = append(in.Votes, Vote{PollID: id, Identity: voter, Choice: rng.IntN(4), At: minAt(open + rng.Float64()*2)})
			}
		}
	}

	grouped := map[EventCount]int{}
	for i := 0; i < spec.Events; i++ {
		e := EventCount{Identity: ids[rng.IntN(len(ids))], Minute: rng.IntN(spec.SessionMin)}
		if rng.Float64() < 0.95 {
			e.Kind, e.Value = "reaction", Reactions[rng.IntN(len(Reactions))]
		} else {
			e.Kind = "hand_raise"
		}
		grouped[e]++
	}
	for e, n := range grouped {
		e.Count = n
		in.Events = append(in.Events, e)
	}
	return in
}

func ptrTime(t time.Time) *time.Time { return &t }
func ptrInt(v int) *int              { return &v }
