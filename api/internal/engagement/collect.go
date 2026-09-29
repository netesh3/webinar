package engagement

import (
	"math"
	"strings"
)

func (r *run) collectVisits() {
	lobbySec := float64(-r.lobbyMin * 60)
	sessSec := float64(r.sessSec)
	lastLive := map[*person]int{}

	for _, v := range r.in.Visits {
		if !IsAttendee(v.Identity) {
			continue
		}
		p := r.people[v.Identity]
		if p == nil {
			p = &person{Person: Person{Identity: v.Identity}}
			r.people[v.Identity] = p
		}
		if p.visits == 0 {
			p.presence = make([]float64, r.ax.cols)
			p.intensity = make([]int, r.ax.cols)
			p.pollsSeen = map[string]bool{}
			p.firstSec = math.Inf(1)
			p.lastSec = math.Inf(-1)
			r.order = append(r.order, p)
			lastLive[p] = math.MinInt
		}
		p.visits++

		joined := r.clk.sec(v.Joined)
		left := sessSec
		if v.Left != nil {
			left = math.Min(r.clk.sec(*v.Left), sessSec)
		} else {
			p.open = true
		}
		p.firstSec = math.Min(p.firstSec, joined)
		p.lastSec = math.Max(p.lastSec, left)

		watchFrom, watchTo := math.Max(joined, 0), math.Min(left, sessSec)
		if watchTo > watchFrom {
			p.sig.WatchSec += int(watchTo - watchFrom)
		}

		from := math.Max(joined, lobbySec)
		if left <= from {
			continue
		}
		r.ax.overlap(p.presence, from, left)

		first := int(math.Floor(from / 60))
		last := int(math.Ceil(left/60)) - 1
		if first <= lastLive[p] {
			first = lastLive[p] + 1
		}
		if last >= r.sessMin {
			last = r.sessMin - 1
		}
		if first > last {
			continue
		}
		r.live[first+r.lobbyMin]++
		r.live[last+r.lobbyMin+1]--
		lastLive[p] = last
	}
	for i := 1; i < len(r.live); i++ {
		r.live[i] += r.live[i-1]
	}
	for _, p := range r.order {
		if p.Name == "" {
			p.Name = "Guest"
		}
		p.sig.SessionSec = r.sessSec
	}
}

/* collectChat counts audience messages. A message shorter than two characters, or the same
 * body again from the same person within ten seconds, is kept in the activity series but
 * earns no score — the rule that stops "hi hi hi" from topping the table. */
func (r *run) collectChat() {
	senders := map[string]int{}
	for _, c := range r.in.Chats {
		if !IsAttendee(c.Identity) {
			continue
		}
		p := r.attendee(c.Identity)
		m := r.clk.minute(c.At)
		r.bump(actChat, m, p)
		r.sum.KPIs.ChatMessages++
		senders[c.Identity]++
		if i, ok := r.chatCol(m); ok {
			r.sum.Chat.PerBucket[i]++
		}
		if p == nil {
			continue
		}
		dup := p.hasChatted && c.Hash == p.lastHash && c.At.Sub(p.lastChat) < chatDedupeWindow
		p.lastChat, p.lastHash, p.hasChatted = c.At, c.Hash, true
		if c.Length >= minChatChars && !dup {
			p.sig.Chats++
		}
	}
	r.sum.KPIs.Chatters = len(senders)
	r.sum.KPIs.StageChatMessages = r.in.StageChats
	r.usage[KeyChat] = r.sum.KPIs.ChatMessages > 0

	type named struct {
		name string
		n    int
	}
	top := make([]named, 0, len(senders))
	for id, n := range senders {
		name := "Guest"
		if p := r.people[id]; p != nil && p.Name != "" {
			name = p.Name
		}
		top = append(top, named{name, n})
	}
	sortBy(top, func(a, b named) bool {
		if a.n != b.n {
			return a.n > b.n
		}
		return a.name < b.name
	})
	for i := 0; i < len(top) && i < topChatters; i++ {
		r.sum.Chat.TopChatters = append(r.sum.Chat.TopChatters, types_count(top[i].name, top[i].n))
	}
	for _, l := range r.in.LatestChat {
		r.sum.Chat.Latest = append(r.sum.Chat.Latest, chatLine(r.clk.minute(l.At), l.Name, l.Text))
	}
}

func (r *run) chatCol(minute int) (int, bool) {
	i := floorDiv(minute, r.sum.Chat.BucketMin)
	return i, minute >= 0 && i < len(r.sum.Chat.PerBucket)
}

/* collectQuestions attributes a question to its asker unless it was anonymous, and scores
 * it unless it was dismissed. Both still count in the session's activity. */
func (r *run) collectQuestions() {
	for _, q := range r.in.Questions {
		if !IsAttendee(q.Identity) && q.Identity != "" {
			continue
		}
		var p *person
		if !q.Anonymous {
			p = r.attendee(q.Identity)
		}
		r.bump(actQA, r.clk.minute(q.At), p)
		if !q.Dismissed {
			r.sum.KPIs.Questions++
			if q.Answered {
				r.sum.KPIs.AnsweredQuestions++
			}
			if p != nil {
				p.sig.Questions++
			}
		}
		r.sum.KPIs.Upvotes += q.Upvotes
	}
	for _, u := range r.in.Upvotes {
		if !IsAttendee(u.Identity) {
			continue
		}
		p := r.attendee(u.Identity)
		r.bump(actQA, r.clk.minute(u.At), p)
		if p != nil {
			p.sig.Upvotes++
		}
	}
	r.usage[KeyQA] = len(r.in.Questions) > 0 || len(r.in.Upvotes) > 0

	qs := append([]Question(nil), r.in.Questions...)
	sortBy(qs, func(a, b Question) bool {
		if a.Upvotes != b.Upvotes {
			return a.Upvotes > b.Upvotes
		}
		return a.At.Before(b.At)
	})
	for _, q := range qs {
		if q.Dismissed || len(r.sum.Questions) >= maxListedQuestion {
			continue
		}
		name := q.Name
		if q.Anonymous {
			name = ""
		}
		r.sum.Questions = append(r.sum.Questions, question(q, r.clk.minute(q.At), name))
	}
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}
