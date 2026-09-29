package engagement

import (
	"fmt"
	"math"
	"sort"
	"sync"

	"github.com/netkumar/webcast/api/types"
)

/* Signals is one attendee's raw participation, before any weighting. Extra carries
 * signals from sources added later (a survey, a rating) keyed by name, so a new
 * component can read what its loader wrote without this struct growing a field. */
type Signals struct {
	WatchSec      int
	SessionSec    int
	Chats         int
	Questions     int
	Upvotes       int
	PollsPresent  int
	PollsAnswered int
	QuizPresent   int
	QuizCorrect   int
	Reactions     int
	Hands         int
	Extra         map[string]float64
}

// Usage says which tools ran in a session, by component key.
type Usage map[string]bool

/* Component is one term of the Engagement Score.
 *
 * Used decides whether the tool ran in the session at all; Applies whether it can be
 * judged for this person (a poll launched while they were out of the room cannot).
 * Either being false removes the term and its weight is spread over the rest. */
type Component interface {
	Key() string
	Label() string
	BaseWeight() float64
	Rule() string
	Used(u Usage) bool
	Applies(s Signals) bool
	Ratio(s Signals) (ratio float64, detail string)
}

type Thresholds struct{ High, Engaged, Passive int }

func (t Thresholds) Tier(score int) types.EngagementTier {
	switch {
	case score >= t.High:
		return types.TierHigh
	case score >= t.Engaged:
		return types.TierEngaged
	case score >= t.Passive:
		return types.TierPassive
	}
	return types.TierRisk
}

type Formula struct {
	Version    int
	Components []Component
	Tiers      Thresholds
}

// Weights is each component's effective weight in a session, before per-person absence.
func (f Formula) Weights(u Usage) []types.EngagementWeight {
	total := 0.0
	for _, c := range f.Components {
		if c.Used(u) {
			total += c.BaseWeight()
		}
	}
	out := make([]types.EngagementWeight, 0, len(f.Components))
	for _, c := range f.Components {
		w := 0.0
		if c.Used(u) && total > 0 {
			w = round1(c.BaseWeight() * 100 / total)
		}
		out = append(out, types.EngagementWeight{
			Key: c.Key(), Label: c.Label(), BaseWeight: c.BaseWeight(), Weight: w, Rule: c.Rule(),
		})
	}
	return out
}

// Score is a person's 0–100 score and the breakdown that explains it.
func (f Formula) Score(u Usage, s Signals) (int, []types.EngagementComponent) {
	applicable := make([]Component, 0, len(f.Components))
	total := 0.0
	for _, c := range f.Components {
		if c.Used(u) && c.Applies(s) {
			applicable = append(applicable, c)
			total += c.BaseWeight()
		}
	}
	parts := make([]types.EngagementComponent, 0, len(applicable))
	sum := 0.0
	for _, c := range applicable {
		weight := c.BaseWeight() * 100 / total
		ratio, detail := c.Ratio(s)
		ratio = clamp01(ratio)
		points := weight * ratio
		sum += points
		parts = append(parts, types.EngagementComponent{
			Key: c.Key(), Label: c.Label(), Weight: round1(weight),
			Ratio: math.Round(ratio*1000) / 1000, Points: round1(points), Detail: detail,
		})
	}
	score := int(math.Round(sum))
	if score > 100 {
		score = 100
	}
	return score, parts
}

var (
	registryMu sync.RWMutex
	registry   = map[int]Formula{}
	current    int
)

/* Register makes a formula available by version. The highest registered version is the
 * one new computations use; older ones stay readable so a stored snapshot can still say
 * which rules produced it. */
func Register(f Formula) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[f.Version] = f
	if f.Version > current {
		current = f.Version
	}
}

func Current() Formula {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return registry[current]
}

func Lookup(version int) (Formula, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	f, ok := registry[version]
	return f, ok
}

func Versions() []int {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]int, 0, len(registry))
	for v := range registry {
		out = append(out, v)
	}
	sort.Ints(out)
	return out
}

// Component keys, shared with Usage and the frontend's weight legend.
const (
	KeyWatch     = "watch"
	KeyPolls     = "polls"
	KeyQuiz      = "quiz"
	KeyChat      = "chat"
	KeyQA        = "questions"
	KeyReactions = "reactions"
	KeyHands     = "hands"
	KeySurvey    = "survey"
)

const (
	chatCap      = 5
	questionCap  = 2
	upvoteCap    = 5
	reactionCap  = 10
	handCap      = 1
	surveySignal = SignalSurveyDone
)

func init() {
	Register(Formula{
		Version: 1,
		Tiers:   Thresholds{High: 75, Engaged: 50, Passive: 25},
		Components: []Component{
			spec{KeyWatch, "Watch time", 40, "share of the session watched",
				func(Usage) bool { return true }, always,
				func(s Signals) (float64, string) {
					if s.SessionSec <= 0 {
						return 0, "session did not run"
					}
					return float64(s.WatchSec) / float64(s.SessionSec),
						fmt.Sprintf("%d of %d min", roundMin(s.WatchSec), roundMin(s.SessionSec))
				}},
			spec{KeyPolls, "Polls answered", 15, "polls answered while present",
				used(KeyPolls), func(s Signals) bool { return s.PollsPresent > 0 },
				func(s Signals) (float64, string) {
					return ratio(s.PollsAnswered, s.PollsPresent),
						fmt.Sprintf("%d of %d", s.PollsAnswered, s.PollsPresent)
				}},
			spec{KeyQuiz, "Quiz accuracy", 10, "correct answers; unanswered counts as wrong",
				used(KeyQuiz), func(s Signals) bool { return s.QuizPresent > 0 },
				func(s Signals) (float64, string) {
					return ratio(s.QuizCorrect, s.QuizPresent),
						fmt.Sprintf("%d of %d correct", s.QuizCorrect, s.QuizPresent)
				}},
			spec{KeyChat, "Chat", 10, fmt.Sprintf("max at %d messages", chatCap),
				used(KeyChat), always,
				func(s Signals) (float64, string) {
					return capped(s.Chats, chatCap), fmt.Sprintf("%d %s (cap %d)", s.Chats, plural(s.Chats, "message"), chatCap)
				}},
			spec{KeyQA, "Q&A", 10, "asking counts double an upvote",
				used(KeyQA), always,
				func(s Signals) (float64, string) {
					r := float64(s.Questions)/questionCap + 0.5*float64(s.Upvotes)/upvoteCap
					return r, fmt.Sprintf("%d asked · %d %s", s.Questions, s.Upvotes, plural(s.Upvotes, "upvote"))
				}},
			spec{KeyReactions, "Reactions", 5, fmt.Sprintf("max at %d", reactionCap),
				used(KeyReactions), always,
				func(s Signals) (float64, string) {
					return capped(s.Reactions, reactionCap), fmt.Sprintf("%d (cap %d)", s.Reactions, reactionCap)
				}},
			spec{KeyHands, "Raised hand", 5, "raised at least once",
				used(KeyHands), always,
				func(s Signals) (float64, string) {
					if s.Hands > 0 {
						return capped(s.Hands, handCap), "Yes"
					}
					return 0, "No"
				}},
			spec{KeySurvey, "Survey", 5, "completed the post-event survey",
				used(KeySurvey), always,
				func(s Signals) (float64, string) {
					if s.Extra[surveySignal] > 0 {
						return 1, "Completed"
					}
					return 0, "Not completed"
				}},
		},
	})
}

/* Formula v2: the survey term gets a real source (api/internal/store/surveys*.go) and a
 * partial credit. Everything else is v1 unchanged, so a session with no survey scores
 * exactly as it did.
 *
 *   submitted (a built-in survey, or the rating asked before a link)  → full credit
 *   only pressed "Open survey" on a link survey                       → half credit
 *   neither                                                            → nothing
 *
 * Half, because a click is intent we can see but not completion we can verify: the answers
 * live on the host's own form. The term only counts once the survey was actually sent
 * (Usage["survey"], set by the loader for a live or closed survey), and then for every
 * attendee — an early leaver is offered it on the way out. */
const surveyClickCredit = 0.5

func init() {
	v1, _ := Lookup(1)
	components := make([]Component, 0, len(v1.Components))
	for _, c := range v1.Components {
		if c.Key() == KeySurvey {
			c = spec{KeySurvey, "Survey", 5, "completed the post-event survey; opening a survey link counts half",
				used(KeySurvey), always, surveyRatio}
		}
		components = append(components, c)
	}
	Register(Formula{Version: 2, Tiers: v1.Tiers, Components: components})
}

func surveyRatio(s Signals) (float64, string) {
	switch {
	case s.Extra[SignalSurveyDone] > 0:
		if r := int(s.Extra[SignalSurveyRating]); r > 0 {
			return 1, fmt.Sprintf("Completed · rated %d/5", r)
		}
		return 1, "Completed"
	case s.Extra[SignalSurveyClicked] > 0:
		return surveyClickCredit, "Opened the survey link"
	}
	return 0, "Not completed"
}

// spec is a Component built from plain functions, which is all the v1 terms need.
type spec struct {
	key, label string
	weight     float64
	rule       string
	usedFn     func(Usage) bool
	appliesFn  func(Signals) bool
	ratioFn    func(Signals) (float64, string)
}

func (c spec) Key() string                       { return c.key }
func (c spec) Label() string                     { return c.label }
func (c spec) BaseWeight() float64               { return c.weight }
func (c spec) Rule() string                      { return c.rule }
func (c spec) Used(u Usage) bool                 { return c.usedFn(u) }
func (c spec) Applies(s Signals) bool            { return c.appliesFn(s) }
func (c spec) Ratio(s Signals) (float64, string) { return c.ratioFn(s) }

func used(key string) func(Usage) bool { return func(u Usage) bool { return u[key] } }
func always(Signals) bool              { return true }

func ratio(n, d int) float64 {
	if d <= 0 {
		return 0
	}
	return float64(n) / float64(d)
}

func capped(n, cap int) float64 { return clamp01(float64(n) / float64(cap)) }

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func roundMin(sec int) int { return (sec + 30) / 60 }

func plural(n int, word string) string {
	if n == 1 {
		return word
	}
	return word + "s"
}
