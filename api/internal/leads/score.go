// Package leads ranks the people of one session by how likely they are to buy, book or
// reply, for the host's "Hot leads" card and the follow-up groups.
//
// Everything here is arithmetic on what people did. No model is involved: the AI only
// adds a one-line reason to a lead already ranked here (see aiwrite/leads.go), so the
// order, the score and the tag are the same whether AI is on or off.
package leads

import (
	"math"
	"sort"
	"strings"
)

/* The lead score, 0 to 100. Simple on purpose: a host should be able to read why somebody
 * scored 72 off the chips beside the name.
 *
 *   watched live     up to 40   40 × the share of the session they were in the room
 *   watched replay   up to 15   only when they did not stay past half live: 15 × the share
 *                               of the replay they watched (10 when only "opened")
 *   questions        10 each, up to 20; +1 per upvote their questions got, up to 5
 *   chat             2 per message, up to 10
 *   polls            3 per answer, up to 9
 *   raised hand      5
 *   came on stage    10
 *   offer / CTA      15 for clicking the host's offer at least once
 *
 * Capped at 100. A registrant who never joined live and never watched the replay is a
 * no-show and scores 0.
 *
 * Tags: hot at 55 and over (stayed to the end and asked or chatted, or clicked the offer and
 * stayed), warm from 30 (stayed three quarters of the session, or took part briefly), cold below.
 */
const (
	WeightLiveWatch   = 40.0
	WeightReplay      = 15.0
	ReplayOpenedPts   = 10.0
	PtsPerQuestion    = 10
	MaxQuestionPts    = 20
	MaxUpvotePts      = 5
	PtsPerChat        = 2
	MaxChatPts        = 10
	PtsPerPollAnswer  = 3
	MaxPollPts        = 9
	PtsRaisedHand     = 5
	PtsOnStage        = 10
	PtsOfferClick     = 15
	HotAt             = 55
	WarmAt            = 30
	AttendedThreshold = 0.5
)

// Tags.
const (
	TagHot  = "hot"
	TagWarm = "warm"
	TagCold = "cold"
)

// Follow-up groups. Hot is a group too, but overlaps the others (see Groups).
const (
	GroupAttended  = "attended"
	GroupLeftEarly = "left_early"
	GroupNoShow    = "no_show"
	GroupHot       = "hot"
)

// Signals is what one person did in one session.
type Signals struct {
	// WatchSec is time in the live room; SessionSec the length of the live session.
	WatchSec   int
	SessionSec int
	// Joined is true when they were ever in the live room.
	Joined bool
	// ReplaySec is how long they watched the replay; ReplayOpened that they opened it.
	ReplaySec    int
	ReplayOpened bool
	Questions    int
	// Upvotes is the total their questions received.
	Upvotes     int
	Chats       int
	PollAnswers int
	RaisedHand  bool
	OnStage     bool
	OfferClicks int
}

// WatchShare is the share of the live session they were in the room, 0 to 1.
func (s Signals) WatchShare() float64 {
	if s.SessionSec <= 0 {
		if s.Joined {
			return 1
		}
		return 0
	}
	return clamp01(float64(s.WatchSec) / float64(s.SessionSec))
}

// NoShow is a registrant who never joined live.
func (s Signals) NoShow() bool { return !s.Joined }

// Score is the lead score, 0 to 100 (see the formula above).
func Score(s Signals) int {
	pts := 0.0
	share := s.WatchShare()
	if s.Joined {
		pts += WeightLiveWatch * share
	}
	if share < AttendedThreshold {
		switch {
		case s.ReplaySec > 0 && s.SessionSec > 0:
			pts += WeightReplay * clamp01(float64(s.ReplaySec)/float64(s.SessionSec))
		case s.ReplayOpened || s.ReplaySec > 0:
			pts += ReplayOpenedPts
		}
	}
	pts += float64(min(s.Questions*PtsPerQuestion, MaxQuestionPts))
	pts += float64(min(max(s.Upvotes, 0), MaxUpvotePts))
	pts += float64(min(s.Chats*PtsPerChat, MaxChatPts))
	pts += float64(min(s.PollAnswers*PtsPerPollAnswer, MaxPollPts))
	if s.RaisedHand {
		pts += PtsRaisedHand
	}
	if s.OnStage {
		pts += PtsOnStage
	}
	if s.OfferClicks > 0 {
		pts += PtsOfferClick
	}
	return min(100, int(math.Round(pts)))
}

// Tag is hot, warm or cold for a score.
func Tag(score int) string {
	switch {
	case score >= HotAt:
		return TagHot
	case score >= WarmAt:
		return TagWarm
	}
	return TagCold
}

// Group is the follow-up group a person is in by attendance: attended (stayed at least
// half the live session), left_early (joined, under half) or no_show (never joined live).
func Group(s Signals) string {
	switch {
	case !s.Joined:
		return GroupNoShow
	case s.WatchShare() >= AttendedThreshold:
		return GroupAttended
	}
	return GroupLeftEarly
}

// Person is one lead before ranking. Key is stable across calls for the same person in
// the same session (the registration id, else the room identity).
type Person struct {
	Key     string
	Name    string
	Email   string
	Phone   string
	Signals Signals
}

// Ranked is a Person with their score, tag and group.
type Ranked struct {
	Person
	Score int
	Tag   string
	Group string
}

// Rank scores everybody and orders them: highest score first, then longest watched, then
// by name, so the order is the same on every load.
func Rank(people []Person) []Ranked {
	out := make([]Ranked, 0, len(people))
	for _, p := range people {
		sc := Score(p.Signals)
		out = append(out, Ranked{Person: p, Score: sc, Tag: Tag(sc), Group: Group(p.Signals)})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		if a.Signals.WatchSec != b.Signals.WatchSec {
			return a.Signals.WatchSec > b.Signals.WatchSec
		}
		if na, nb := strings.ToLower(a.Name), strings.ToLower(b.Name); na != nb {
			return na < nb
		}
		return a.Key < b.Key
	})
	return out
}

// Top is the first n ranked people worth a reason: those who scored anything at all.
func Top(ranked []Ranked, n int) []Ranked {
	out := make([]Ranked, 0, min(n, len(ranked)))
	for _, r := range ranked {
		if len(out) == n {
			break
		}
		if r.Score > 0 {
			out = append(out, r)
		}
	}
	return out
}

// GroupCounts counts each follow-up group; hot counts the hot-tagged, whatever their group.
func GroupCounts(ranked []Ranked) map[string]int {
	out := map[string]int{GroupAttended: 0, GroupLeftEarly: 0, GroupNoShow: 0, GroupHot: 0}
	for _, r := range ranked {
		out[r.Group]++
		if r.Tag == TagHot {
			out[GroupHot]++
		}
	}
	return out
}

// InGroup reports whether a ranked person belongs to a follow-up group.
func InGroup(r Ranked, group string) bool {
	if group == GroupHot {
		return r.Tag == TagHot
	}
	return r.Group == group
}

// ValidGroup reports whether group is one of the four follow-up groups.
func ValidGroup(group string) bool {
	switch group {
	case GroupAttended, GroupLeftEarly, GroupNoShow, GroupHot:
		return true
	}
	return false
}

// Groups is the four groups in the order the follow-up writer shows them.
var Groups = []string{GroupHot, GroupAttended, GroupLeftEarly, GroupNoShow}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }
