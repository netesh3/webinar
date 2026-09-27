package engagement

import (
	"sort"
	"time"

	"github.com/netkumar/webcast/api/types"
)

// Scored is one attendee's computed row plus what is stored beside it.
type Scored struct {
	Row            types.EngagementAttendeeRow
	RegistrationID string
	WatchSec       int
	Components     []types.EngagementComponent
}

type Result struct {
	Summary types.EngagementSummary
	Rows    []Scored
}

// person accumulates one attendee across every source.
type person struct {
	Person
	sig          Signals
	visits       int
	firstSec     float64
	lastSec      float64
	open         bool
	presence     []float64
	intensity    []int
	pollsSeen    map[string]bool
	lastChat     time.Time
	lastHash     int64
	hasChatted   bool
	quizAnswered int
}

// run holds the state of one Compute call.
type run struct {
	in       Input
	f        Formula
	clk      clock
	sessMin  int
	sessSec  int
	lobbyMin int
	ax       axis
	act      axis
	people   map[string]*person
	order    []*person
	live     []int
	activity [4][]int
	usage    Usage
	sum      types.EngagementSummary

	reactionCols int
	emoji        map[string]*types.EngagementEmojiSeries
	liveAtOpen   int
	pollVotes    int
	quizVotes    int
	quizCorrect  int
}

const (
	actChat = iota
	actQA
	actPoll
	actReaction
)

var activityKinds = [4]string{"chat", "qa", "poll", "reaction"}

// Compute is the whole aggregation for one webinar under formula f.
func Compute(in Input, f Formula) Result {
	r := &run{in: in, f: f, people: map[string]*person{}, usage: Usage{}}
	r.sum = types.EngagementSummary{
		FormulaVersion: f.Version,
		ComputedAt:     in.Now.UTC().Format(time.RFC3339),
		Webinar: types.EngagementWebinar{
			Slug: in.Webinar.Slug, Title: in.Webinar.Title, HostName: in.Webinar.HostName,
			TimeZone: in.Webinar.TimeZone, Status: in.Webinar.Status,
		},
	}
	r.sum.KPIs.Registered = in.Registered
	r.sum.KPIs.NoShows = in.Registered
	r.sum.Tiers.NoShow = in.Registered
	r.sum.KPIs.PollResponsePct, r.sum.KPIs.QuizAccuracyPct = -1, -1

	if in.Webinar.StartedAt == nil {
		r.sum.State = types.EngagementNotStarted
		r.sum.Weights = f.Weights(r.usage)
		r.emptySeries()
		return Result{Summary: r.sum, Rows: []Scored{}}
	}
	r.frame()
	r.collectPeople()
	r.collectVisits()
	if len(r.order) == 0 {
		r.sum.State = types.EngagementNoAudience
		r.sum.Weights = f.Weights(r.usage)
		r.buildSeries()
		return Result{Summary: r.sum, Rows: []Scored{}}
	}
	r.sum.State = types.EngagementReady
	r.collectChat()
	r.collectQuestions()
	r.collectPolls()
	r.collectEvents()
	for k, v := range in.ExtraUsage {
		r.usage[k] = r.usage[k] || v
	}
	rows := r.score()
	r.buildSeries()
	r.buildKPIs(rows)
	r.buildCallouts()
	return Result{Summary: r.sum, Rows: rows}
}

// frame fixes the live window, the lobby and the two column layouts.
func (r *run) frame() {
	start := *r.in.Webinar.StartedAt
	hi := r.in.Now
	if r.in.Webinar.EndedAt != nil {
		hi = *r.in.Webinar.EndedAt
	}
	if hi.Before(start) {
		hi = start
	}
	r.clk = clock{start: start, hi: hi}
	r.sessSec = int(hi.Sub(start).Seconds())
	r.sessMin = max(1, ceilDiv(r.sessSec, 60))

	for _, v := range r.in.Visits {
		if IsAttendee(v.Identity) && v.Joined.Before(start) {
			r.lobbyMin = lobbyMaxMin
			break
		}
	}

	total := r.lobbyMin + r.sessMin
	bucket := niceStep(total, maxAxisCols, axisSteps)
	lobbyCols := ceilDiv(r.lobbyMin, bucket)
	r.ax = axis{startMin: -lobbyCols * bucket, bucket: bucket}
	r.ax.cols = lobbyCols + ceilDiv(r.sessMin, bucket)
	r.sum.Axis = types.EngagementAxis{
		BucketMin: bucket, StartMin: r.ax.startMin, Columns: r.ax.cols, LobbyColumns: lobbyCols,
	}

	step := niceStep(r.sessMin, maxActivityCols, activitySteps)
	r.act = axis{startMin: 0, bucket: step, cols: ceilDiv(r.sessMin, step)}
	for i := range r.activity {
		r.activity[i] = make([]int, r.act.cols)
	}
	r.live = make([]int, r.lobbyMin+r.sessMin+1)

	sessCols := ceilDiv(r.sessMin, bucket)
	r.sum.Chat = types.EngagementChat{
		BucketMin: bucket, PerBucket: make([]int, sessCols),
		TopChatters: []types.EngagementCount{}, Latest: []types.EngagementChatLine{},
	}
	r.sum.Reactions = types.EngagementReactions{BucketMin: bucket, Series: []types.EngagementEmojiSeries{}}
	r.reactionCols = sessCols

	r.sum.Webinar.StartedAt = start.UTC().Format(time.RFC3339)
	if r.in.Webinar.EndedAt != nil {
		r.sum.Webinar.EndedAt = r.in.Webinar.EndedAt.UTC().Format(time.RFC3339)
	}
	r.sum.Webinar.SessionMin = r.sessMin
}

func (r *run) collectPeople() {
	for _, p := range r.in.People {
		if IsAttendee(p.Identity) {
			r.people[p.Identity] = &person{Person: p}
		}
	}
}

// attendee is the accumulator for an identity that has at least one visit.
func (r *run) attendee(identity string) *person {
	p := r.people[identity]
	if p == nil || p.visits == 0 {
		return nil
	}
	return p
}

func (r *run) bump(kind int, minute int, p *person) { r.bumpN(kind, minute, p, 1) }

func (r *run) bumpN(kind int, minute int, p *person, n int) {
	if i, ok := r.act.col(minute); ok {
		r.activity[kind][i] += n
	}
	if p != nil {
		if i, ok := r.ax.col(minute); ok {
			p.intensity[i] += n
		}
	}
}

func (r *run) sorted() []*person {
	out := append([]*person(nil), r.order...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].firstSec < out[j].firstSec })
	return out
}
