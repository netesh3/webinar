package survey

import (
	"math"

	"github.com/netkumar/webcast/api/types"
)

/* Bucket is one GROUP BY row of numeric answers: how many people gave Number to QuestionID.
 * The store does the grouping, so a 5,000-person survey arrives as a few dozen rows. */
type Bucket struct {
	QuestionID string
	Number     int
	Count      int
}

// Tally is everything Aggregate needs, as loaded by the store.
type Tally struct {
	Survey   types.Survey
	Attended int
	// Responses is submitted responses; LinkClicks is attendees who pressed Open survey.
	Responses  int
	LinkClicks int
	// RatingCounts[i] is how many gave the overall rating i+1.
	RatingCounts [5]int
	Numbers      []Bucket
	// TextCounts is how many non-empty text answers each text question has.
	TextCounts map[string]int
	Comments   []types.SurveyComment
}

// Aggregate turns a tally into the results page. Pure; the store supplies every number.
func Aggregate(t Tally) types.SurveyResults {
	s := t.Survey
	out := types.SurveyResults{
		Configured:         true,
		Mode:               s.Mode,
		Status:             s.Status,
		Title:              s.Title,
		LaunchedAt:         s.LaunchedAt,
		Attended:           t.Attended,
		Responses:          t.Responses,
		ResponseRatePct:    pct(t.Responses, t.Attended),
		LinkClicks:         t.LinkClicks,
		ClickThroughPct:    pct(t.LinkClicks, t.Attended),
		RatingDistribution: t.RatingCounts[:],
		AverageRating:      -1,
		Questions:          []types.SurveyQuestionResult{},
		Comments:           t.Comments,
	}
	if out.Comments == nil {
		out.Comments = []types.SurveyComment{}
	}
	if s.Mode != types.SurveyLink {
		out.LinkClicks, out.ClickThroughPct = 0, -1
	}
	sum := 0
	for i, n := range t.RatingCounts {
		out.Ratings += n
		sum += n * (i + 1)
	}
	if out.Ratings > 0 {
		out.AverageRating = round1(float64(sum) / float64(out.Ratings))
	}

	counts := map[string]map[int]int{}
	for _, b := range t.Numbers {
		if counts[b.QuestionID] == nil {
			counts[b.QuestionID] = map[int]int{}
		}
		counts[b.QuestionID][b.Number] += b.Count
	}
	for _, q := range s.Questions {
		r := types.SurveyQuestionResult{ID: q.ID, Kind: q.Kind, Prompt: q.Prompt, Average: -1, Distribution: []int{}}
		if q.Kind == types.SurveyText {
			r.Answered = t.TextCounts[q.ID]
			out.Questions = append(out.Questions, r)
			continue
		}
		lo, hi := Range(q)
		dist := make([]int, max(0, hi-lo+1))
		total, weighted := 0, 0
		for v, n := range counts[q.ID] {
			if v < lo || v > hi {
				continue
			}
			dist[v-lo] += n
			total += n
			weighted += v * n
		}
		r.Answered, r.Distribution = total, dist
		switch q.Kind {
		case types.SurveyRating5, types.SurveyNPS10:
			if total > 0 {
				r.Average = round1(float64(weighted) / float64(total))
			}
			if q.Kind == types.SurveyNPS10 {
				nps := NPS(dist)
				r.NPS = &nps
				if out.NPS == nil {
					out.NPS = &nps
				}
			}
		case types.SurveySingleChoice:
			r.Choices = make([]types.SurveyChoiceCount, len(q.Options))
			for i, label := range q.Options {
				r.Choices[i] = types.SurveyChoiceCount{Label: label, Count: dist[i]}
			}
		}
		out.Questions = append(out.Questions, r)
	}
	return out
}

/* NPS scores an 0–10 distribution (dist[i] = people who answered i): the percentage of
 * promoters (9–10) minus the percentage of detractors (0–6), rounded to a whole number in
 * −100..100. Zero responses score 0 with Responses 0, which the page shows as "no answers". */
func NPS(dist []int) types.SurveyNPS {
	var n types.SurveyNPS
	for v, c := range dist {
		switch {
		case v >= 9:
			n.Promoters += c
		case v >= 7:
			n.Passives += c
		default:
			n.Detractors += c
		}
		n.Responses += c
	}
	if n.Responses > 0 {
		n.Score = int(math.Round(float64(n.Promoters-n.Detractors) * 100 / float64(n.Responses)))
	}
	return n
}

func pct(n, d int) int {
	if d <= 0 {
		return -1
	}
	return min(100, int(math.Round(float64(n)*100/float64(d))))
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
