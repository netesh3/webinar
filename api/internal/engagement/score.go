package engagement

import (
	"math"
	"sort"

	"github.com/netkumar/webcast/api/types"
)

func (r *run) score() []Scored {
	rows := make([]Scored, 0, len(r.order))
	for _, p := range r.sorted() {
		if extra := r.in.Extra[p.Identity]; extra != nil {
			p.sig.Extra = extra
		}
		score, parts := r.f.Score(r.usage, p.sig)
		tier := r.f.Tiers.Tier(score)
		switch tier {
		case types.TierHigh:
			r.sum.Tiers.High++
		case types.TierEngaged:
			r.sum.Tiers.Engaged++
		case types.TierPassive:
			r.sum.Tiers.Passive++
		default:
			r.sum.Tiers.Risk++
		}

		presence := make([]int, len(p.presence))
		for i, s := range p.presence {
			if span := r.colSpan(i); span > 0 {
				presence[i] = min(100, int(math.Round(s*100/span)))
			}
		}
		last := int(math.Ceil(p.lastSec / 60))
		if p.open {
			last = -1
		}
		first := int(math.Floor(p.firstSec / 60))
		rows = append(rows, Scored{
			RegistrationID: p.RegistrationID,
			WatchSec:       p.sig.WatchSec,
			Components:     parts,
			Row: types.EngagementAttendeeRow{
				Identity: p.Identity, Name: p.Name, Email: p.Email,
				Score: score, Tier: tier,
				WatchMin:     roundMin(p.sig.WatchSec),
				FirstJoinMin: first,
				LastLeaveMin: last,
				JoinTiming:   joinTiming(p.firstSec),
				Visits:       p.visits,
				Counts: types.EngagementCounts{
					Chats: p.sig.Chats, Questions: p.sig.Questions, Upvotes: p.sig.Upvotes,
					Polls: p.sig.PollsAnswered, PollsPresent: p.sig.PollsPresent,
					QuizCorrect: p.sig.QuizCorrect, QuizAnswered: quizAnswered(r, p),
					QuizPresent: p.sig.QuizPresent,
					Reactions:   p.sig.Reactions, Hands: p.sig.Hands,
				},
				Presence:  presence,
				Intensity: p.intensity,
			},
		})
	}
	r.sum.Weights = r.f.Weights(r.usage)
	return rows
}

func quizAnswered(_ *run, p *person) int { return p.quizAnswered }

// colSpan is how many seconds of column i fall inside the drawn window (lobby + session).
func (r *run) colSpan(i int) float64 {
	lo := float64((r.ax.startMin + i*r.ax.bucket) * 60)
	hi := lo + float64(r.ax.bucket*60)
	return math.Min(hi, float64(r.sessSec)) - math.Max(lo, float64(-r.lobbyMin*60))
}

func joinTiming(firstSec float64) types.JoinTiming {
	switch {
	case firstSec < 0:
		return types.JoinEarly
	case firstSec <= onTimeGraceMin*60:
		return types.JoinOnTime
	}
	return types.JoinLate
}

func (r *run) emptySeries() {
	r.sum.Retention = []types.EngagementPoint{}
	r.sum.JoinHistogram = []types.EngagementJoinBucket{}
	r.sum.JoinBucketMin = joinBucketMin
	r.sum.Activity = types.EngagementActivity{BucketMin: 1, Chat: []int{}, QA: []int{}, Poll: []int{}, Reaction: []int{}}
	r.sum.Markers = []types.EngagementMarker{}
	r.sum.Polls = []types.EngagementPoll{}
	r.sum.Reactions = types.EngagementReactions{BucketMin: 1, Series: []types.EngagementEmojiSeries{}}
	r.sum.Chat = types.EngagementChat{BucketMin: 1, PerBucket: []int{}, TopChatters: []types.EngagementCount{}, Latest: []types.EngagementChatLine{}}
	r.sum.Questions = []types.EngagementQuestion{}
}

func (r *run) buildSeries() {
	step := niceStep(r.lobbyMin+r.sessMin, maxRetentionPts, retentionSteps)
	r.sum.RetentionStep = step
	r.sum.Retention = []types.EngagementPoint{}
	for m := -r.lobbyMin; m < r.sessMin; m += step {
		r.sum.Retention = append(r.sum.Retention, types.EngagementPoint{Minute: m, Live: r.live[m+r.lobbyMin]})
	}

	r.sum.Activity = types.EngagementActivity{
		BucketMin: r.act.bucket,
		Chat:      r.activity[actChat], QA: r.activity[actQA],
		Poll: r.activity[actPoll], Reaction: r.activity[actReaction],
	}

	r.sum.JoinBucketMin = joinBucketMin
	r.sum.JoinHistogram = []types.EngagementJoinBucket{}
	lo := -roundUp(r.lobbyMin, joinBucketMin)
	hi := min(joinHistogramTo, roundUp(r.sessMin, joinBucketMin))
	for m := lo; m < hi; m += joinBucketMin {
		r.sum.JoinHistogram = append(r.sum.JoinHistogram, types.EngagementJoinBucket{FromMin: m})
	}
	openTail := hi < r.sessMin
	if openTail {
		r.sum.JoinHistogram = append(r.sum.JoinHistogram, types.EngagementJoinBucket{FromMin: hi, Open: true})
	}
	for _, p := range r.order {
		m := int(math.Floor(p.firstSec / 60))
		i := floorDiv(m-lo, joinBucketMin)
		if i < 0 {
			i = 0
		}
		if i >= len(r.sum.JoinHistogram) {
			i = len(r.sum.JoinHistogram) - 1
		}
		if i >= 0 {
			r.sum.JoinHistogram[i].Count++
		}
		switch joinTiming(p.firstSec) {
		case types.JoinEarly:
			r.sum.JoinSplit.Early++
		case types.JoinOnTime:
			r.sum.JoinSplit.OnTime++
		default:
			r.sum.JoinSplit.Late++
		}
	}
	if r.sum.Markers == nil {
		r.sum.Markers = []types.EngagementMarker{}
	}
	if r.sum.Polls == nil {
		r.sum.Polls = []types.EngagementPoll{}
	}
	if r.sum.Questions == nil {
		r.sum.Questions = []types.EngagementQuestion{}
	}
	sort.SliceStable(r.sum.Markers, func(i, j int) bool { return r.sum.Markers[i].Minute < r.sum.Markers[j].Minute })
}

func roundUp(n, step int) int { return ceilDiv(n, step) * step }

func (r *run) buildKPIs(rows []Scored) {
	k := &r.sum.KPIs
	n := len(rows)
	k.Attended = n
	k.NoShows = max(0, r.in.Registered-r.registeredAttended())
	r.sum.Tiers.NoShow = k.NoShows
	k.AttendanceRatePct = pct(r.registeredAttended(), r.in.Registered)

	watch := make([]int, n)
	total, scoreSum, pastHalf := 0, 0, 0
	for i, s := range rows {
		watch[i] = s.WatchSec
		total += s.WatchSec
		scoreSum += s.Row.Score
		if p := r.people[s.Row.Identity]; p != nil && (p.open || p.lastSec > float64(r.sessSec)/2) {
			pastHalf++
		}
	}
	sort.Ints(watch)
	k.AvgWatchMin = roundMin(total / n)
	k.MedianWatchMin = roundMin(median(watch))
	k.AvgWatchPct = min(100, pct(total/n, r.sessSec))
	k.StayedPastHalfPct = pct(pastHalf, n)
	r.sum.Index = int(math.Round(float64(scoreSum) / float64(n)))
	r.sum.Band = band(r.sum.Index)

	for m := 0; m < r.sessMin; m++ {
		if v := r.live[m+r.lobbyMin]; v > k.PeakLive {
			k.PeakLive, k.PeakMinute = v, m
		}
	}
	if r.usage[KeyPolls] {
		k.PollResponsePct = min(100, pct(r.pollVotes, r.liveAtOpen))
	}
	if r.usage[KeyQuiz] {
		k.QuizAccuracyPct = pct(r.quizCorrect, r.quizVotes)
	}
}

// registeredAttended is attendees who hold a registration, the numerator of show-up rate.
func (r *run) registeredAttended() int {
	n := 0
	for _, p := range r.order {
		if p.RegistrationID != "" {
			n++
		}
	}
	return n
}

func median(sorted []int) int {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return sorted[n/2]
	}
	return (sorted[n/2-1] + sorted[n/2]) / 2
}

func band(index int) types.EngagementBand {
	switch {
	case index >= 70:
		return types.BandExcellent
	case index >= 55:
		return types.BandStrong
	case index >= 40:
		return types.BandGood
	}
	return types.BandAttention
}

func (r *run) buildCallouts() {
	for i := 0; i < r.act.cols; i++ {
		sum, top := 0, 0
		for k := range r.activity {
			sum += r.activity[k][i]
			if r.activity[k][i] > r.activity[top][i] {
				top = k
			}
		}
		if sum > 0 && (r.sum.Callouts.BestMoment == nil || sum > r.sum.Callouts.BestMoment.Actions) {
			r.sum.Callouts.BestMoment = &types.EngagementMoment{
				Minute: i * r.act.bucket, Actions: sum, Kind: activityKinds[top],
			}
		}
	}

	var drop *types.EngagementDrop
	for m := 0; m+dropWindowMin < r.sessMin; m++ {
		lost := r.live[m+r.lobbyMin] - r.live[m+dropWindowMin+r.lobbyMin]
		if lost > 0 && (drop == nil || lost > drop.Lost) {
			drop = &types.EngagementDrop{Minute: m, Lost: lost}
		}
	}
	r.sum.Callouts.BiggestDrop = drop

	for _, pl := range r.sum.Polls {
		if pl.Kind != "quiz" || pl.Correct == nil {
			continue
		}
		total := 0
		for _, v := range pl.Votes {
			total += v
		}
		if total == 0 {
			continue
		}
		c := pct(pl.Votes[*pl.Correct], total)
		if r.sum.Callouts.NeedsRecap == nil || c < r.sum.Callouts.NeedsRecap.CorrectPct {
			r.sum.Callouts.NeedsRecap = &types.EngagementRecap{PollID: pl.ID, Question: pl.Question, CorrectPct: c}
		}
	}
}
