package engagement

import (
	"math"
	"time"
)

const (
	lobbyMaxMin       = 10
	onTimeGraceMin    = 5
	joinBucketMin     = 5
	joinHistogramTo   = 30
	maxActivityCols   = 120
	maxAxisCols       = 36
	maxRetentionPts   = 360
	dropWindowMin     = 5
	chatDedupeWindow  = 10 * time.Second
	minChatChars      = 2
	topChatters       = 6
	latestChatLines   = 5
	maxListedQuestion = 50
	markerLabelChars  = 40
)

var (
	activitySteps  = []int{1, 2, 3, 5, 10, 15, 30, 60}
	axisSteps      = []int{5, 10, 15, 20, 30, 60, 120, 240}
	retentionSteps = []int{1, 2, 5, 10, 15, 30, 60}
)

// niceStep is the smallest step from steps that keeps span within max columns.
func niceStep(span, max int, steps []int) int {
	for _, s := range steps {
		if ceilDiv(span, s) <= max {
			return s
		}
	}
	last := steps[len(steps)-1]
	for ceilDiv(span, last) > max {
		last *= 2
	}
	return last
}

func ceilDiv(a, b int) int {
	if b <= 0 {
		return 0
	}
	if a <= 0 {
		return 0
	}
	return (a + b - 1) / b
}

// floorDiv rounds toward negative infinity, so lobby minutes bucket correctly.
func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// clock converts instants to offsets from the webinar's start.
type clock struct {
	start time.Time
	hi    time.Time
}

func (c clock) sec(t time.Time) float64 { return t.Sub(c.start).Seconds() }

func (c clock) minute(t time.Time) int { return int(math.Floor(c.sec(t) / 60)) }

// axis is a run of equal-width columns in minutes, starting at startMin.
type axis struct {
	startMin, bucket, cols int
}

func (a axis) col(minute int) (int, bool) {
	i := floorDiv(minute-a.startMin, a.bucket)
	return i, i >= 0 && i < a.cols
}

/* overlap adds each column's overlap with [from, to) seconds into dst, in seconds.
 * Visits are short relative to the axis, so this walks only the columns a visit spans. */
func (a axis) overlap(dst []float64, from, to float64) {
	if to <= from {
		return
	}
	w := float64(a.bucket * 60)
	base := float64(a.startMin * 60)
	first := int(math.Floor((from - base) / w))
	last := int(math.Floor((to - base) / w))
	for i := max(first, 0); i <= last && i < a.cols; i++ {
		lo := base + float64(i)*w
		hi := lo + w
		if v := math.Min(hi, to) - math.Max(lo, from); v > 0 {
			dst[i] += v
		}
	}
}

func pct(n, d int) int {
	if d <= 0 {
		return 0
	}
	return int(math.Round(float64(n) * 100 / float64(d)))
}
