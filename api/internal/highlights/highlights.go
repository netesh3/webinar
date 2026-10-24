/* Package highlights finds the moments of a recorded session worth cutting into short clips.
 *
 * Two halves, and only one of them is a model. The engagement is counted here: every reaction,
 * chat line, question (with its upvotes) and poll launch placed on the recording's own
 * timeline, and the stretches where the audience came alive found by sliding a window along it
 * (Peaks). The model (aiwrite.HighlightsMessages) reads the transcript with those peaks beside
 * it and picks and titles the moments; this package then makes its picks usable (Snap): each
 * starts and ends on a sentence boundary from the caption timestamps, lasts 20 to 90 seconds,
 * and lies inside one take of the recording, so a clip can be cut from one file. The final
 * order (Rank) weighs the model's interest score against the counted engagement, so a moment
 * the audience reacted to is not lost to one the model merely liked.
 *
 * Times here are seconds on the recording's player timeline: its takes end to end, as the
 * player plays them (captionvtt.Spans).
 *
 * Pure: no database, no clock, no model. */
package highlights

import (
	"math"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/captionvtt"
	"github.com/netkumar/webcast/api/types"
)

// Event kinds (Event.Kind), as the store reads them.
const (
	KindReaction = "reaction"
	KindChat     = "chat"
	KindQuestion = "question"
	KindPoll     = "poll"
)

// Event is one thing the audience did, wall-clock. N is how many: reactions in that second,
// 1 + upvotes for a question, 1 otherwise.
type Event struct {
	At   time.Time
	Kind string
	N    int
}

// Moment is an Event placed on the player timeline.
type Moment struct {
	Sec  float64
	Kind string
	N    int
}

// Sentence is one sentence said, on the player timeline.
type Sentence struct {
	StartSec, EndSec float64
	Speaker, Text    string
}

// Part is one take on the player timeline.
type Part struct {
	ID               string
	StartSec, EndSec float64
}

// Lag is how long after something is said the audience's reaction to it still counts: a
// reaction lands seconds after the line that earned it.
const Lag = 10.0

// window and step are Peaks' sliding window and its stride, in seconds.
const (
	window = 45.0
	step   = 5.0
)

// Weights of each kind of engagement in a stretch's score: a question or a poll is somebody
// doing more than tapping an emoji.
var weights = map[string]float64{KindReaction: 1, KindChat: 2, KindQuestion: 3, KindPoll: 3}

// OnPlaylist places a wall-clock moment on the player timeline; false when it is not in any take.
func OnPlaylist(spans []captionvtt.Span, t time.Time) (float64, bool) {
	for _, sp := range spans {
		if !t.Before(sp.Start) && t.Before(sp.End) {
			return (sp.Offset + t.Sub(sp.Start)).Seconds(), true
		}
	}
	return 0, false
}

// Moments places events on the player timeline, dropping those outside every take.
func Moments(spans []captionvtt.Span, events []Event) []Moment {
	out := make([]Moment, 0, len(events))
	for _, e := range events {
		if sec, ok := OnPlaylist(spans, e.At); ok && e.N > 0 {
			out = append(out, Moment{Sec: sec, Kind: e.Kind, N: e.N})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Sec < out[j].Sec })
	return out
}

// Parts is the takes as spans on the player timeline, with their ids.
func Parts(spans []captionvtt.Span, ids []string) []Part {
	out := make([]Part, 0, len(spans))
	for i, sp := range spans {
		if i >= len(ids) {
			break
		}
		start := sp.Offset.Seconds()
		out = append(out, Part{ID: ids[i], StartSec: start, EndSec: start + sp.End.Sub(sp.Start).Seconds()})
	}
	return out
}

/* Sentences splits caption lines (already on the player timeline) into sentences, giving each
 * a share of its line's time in proportion to its length. Speech-to-text lines are often
 * several sentences, or half of one: a clip should start where a sentence does. */
func Sentences(lines []Sentence) []Sentence {
	var out []Sentence
	for _, l := range lines {
		text := strings.Join(strings.Fields(l.Text), " ")
		if text == "" {
			continue
		}
		end := l.EndSec
		if end <= l.StartSec {
			end = l.StartSec + captionvtt.GuessDuration(text).Seconds()
		}
		parts := splitSentences(text)
		total := 0
		for _, p := range parts {
			total += utf8.RuneCountInString(p)
		}
		at := l.StartSec
		for _, p := range parts {
			d := (end - l.StartSec) * float64(utf8.RuneCountInString(p)) / float64(max(total, 1))
			out = append(out, Sentence{StartSec: at, EndSec: at + d, Speaker: l.Speaker, Text: p})
			at += d
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartSec < out[j].StartSec })
	return out
}

// splitSentences cuts after . ! ? or … followed by a space and a capital or a digit.
func splitSentences(s string) []string {
	r := []rune(s)
	var out []string
	from := 0
	for i := 0; i < len(r)-2; i++ {
		if !strings.ContainsRune(".!?…", r[i]) || r[i+1] != ' ' {
			continue
		}
		if next := r[i+2]; !unicode.IsUpper(next) && !unicode.IsDigit(next) {
			continue
		}
		out = append(out, strings.TrimSpace(string(r[from:i+1])))
		from = i + 2
	}
	if rest := strings.TrimSpace(string(r[from:])); rest != "" {
		out = append(out, rest)
	}
	return out
}

/* Signals counts what the audience did from startSec to endSec, and Lag seconds after. */
func Signals(moments []Moment, startSec, endSec float64) types.HighlightSignals {
	var s types.HighlightSignals
	for _, m := range moments {
		if m.Sec < startSec || m.Sec > endSec+Lag {
			continue
		}
		switch m.Kind {
		case KindReaction:
			s.Reactions += m.N
		case KindChat:
			s.Chat += m.N
		case KindQuestion:
			s.Questions++
		case KindPoll:
			s.Polls += m.N
		}
	}
	return s
}

// engagement is a stretch's weighted engagement score.
func engagement(moments []Moment, startSec, endSec float64) float64 {
	score := 0.0
	for _, m := range moments {
		if m.Sec >= startSec && m.Sec <= endSec+Lag {
			score += weights[m.Kind] * float64(m.N)
		}
	}
	return score
}

// Peak is a stretch where the audience came alive.
type Peak struct {
	StartSec, EndSec float64
	Signals          types.HighlightSignals
	score            float64
}

/* Peaks is up to k stretches of window seconds with the most engagement, strongest first,
 * none overlapping another. Empty when the audience did nothing at all. */
func Peaks(moments []Moment, durationSec float64, k int) []Peak {
	if len(moments) == 0 || durationSec <= 0 || k <= 0 {
		return nil
	}
	var cands []Peak
	for s := 0.0; s < durationSec; s += step {
		e := math.Min(s+window, durationSec)
		if sc := engagement(moments, s, e); sc > 0 {
			cands = append(cands, Peak{StartSec: s, EndSec: e, score: sc})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	var out []Peak
	for _, c := range cands {
		clash := false
		for _, o := range out {
			// With the lag: two windows sharing one burst are one peak.
			if c.StartSec < o.EndSec+Lag && o.StartSec < c.EndSec+Lag {
				clash = true
				break
			}
		}
		if clash {
			continue
		}
		c.Signals = Signals(moments, c.StartSec, c.EndSec)
		out = append(out, c)
		if len(out) == k {
			break
		}
	}
	return out
}

/* Snap turns a model's pick into a clip that can be cut: from the start of the sentence it
 * begins in to the end of the sentence it ends in, lengthened or shortened a sentence at a time
 * to 20–90 seconds, inside the one take its start is in. ok is false when no such clip exists
 * there (the take is too short, or nothing was said). */
func Snap(startSec, endSec float64, sentences []Sentence, parts []Part) (s, e float64, part Part, ok bool) {
	if endSec < startSec {
		startSec, endSec = endSec, startSec
	}
	part, found := partAt(parts, startSec)
	if !found {
		return 0, 0, Part{}, false
	}
	// The sentences inside this take.
	var in []Sentence
	for _, x := range sentences {
		if x.StartSec >= part.StartSec-0.5 && x.EndSec <= part.EndSec+0.5 {
			in = append(in, x)
		}
	}
	if len(in) == 0 {
		return 0, 0, Part{}, false
	}
	first := sort.Search(len(in), func(i int) bool { return in[i].EndSec > startSec })
	if first == len(in) {
		return 0, 0, Part{}, false
	}
	last := first
	for last+1 < len(in) && in[last+1].StartSec < endSec {
		last++
	}
	length := func() float64 { return in[last].EndSec - in[first].StartSec }
	for length() < types.HighlightMinSec && last+1 < len(in) {
		last++
	}
	for length() < types.HighlightMinSec && first > 0 {
		first--
	}
	for length() > types.HighlightMaxSec && last > first {
		last--
	}
	s, e = in[first].StartSec, in[last].EndSec
	if e-s > types.HighlightMaxSec {
		e = s + types.HighlightMaxSec // one very long sentence: cut it
	}
	// A breath either side, inside the take.
	s = math.Max(part.StartSec, s-0.3)
	e = math.Min(part.EndSec, e+0.5)
	if e-s < types.HighlightMinSec {
		return 0, 0, Part{}, false
	}
	return round1(s), round1(e), part, true
}

func partAt(parts []Part, sec float64) (Part, bool) {
	for _, p := range parts {
		if sec >= p.StartSec && sec < p.EndSec {
			return p, true
		}
	}
	return Part{}, false
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }

// Pick is a moment the model chose, already snapped.
type Pick struct {
	StartSec, EndSec float64
	Part             Part
	Title, Why       string
	// Interest is the model's 1–10 for how well it stands alone as a clip.
	Interest int
}

/* Rank scores picks 0–100 (60% the model's interest, 40% the engagement around the moment
 * against the most engaged pick), drops any that overlap a better one by more than half of the
 * shorter, and keeps the best n in order of score. */
func Rank(picks []Pick, moments []Moment, sentences []Sentence, n int) []types.Highlight {
	type scored struct {
		p     Pick
		eng   float64
		score int
	}
	list := make([]scored, 0, len(picks))
	top := 0.0
	for _, p := range picks {
		eng := engagement(moments, p.StartSec, p.EndSec)
		top = math.Max(top, eng)
		list = append(list, scored{p: p, eng: eng})
	}
	for i := range list {
		interest := float64(min(max(list[i].p.Interest, 1), 10)) / 10
		eng := 0.0
		if top > 0 {
			eng = list[i].eng / top
		}
		list[i].score = int(math.Round(100 * (0.6*interest + 0.4*eng)))
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].score > list[j].score })
	var kept []scored
	for _, c := range list {
		clash := false
		for _, k := range kept {
			overlap := math.Min(c.p.EndSec, k.p.EndSec) - math.Max(c.p.StartSec, k.p.StartSec)
			shorter := math.Min(c.p.EndSec-c.p.StartSec, k.p.EndSec-k.p.StartSec)
			if overlap > shorter/2 {
				clash = true
				break
			}
		}
		if clash {
			continue
		}
		kept = append(kept, c)
		if len(kept) == n {
			break
		}
	}
	out := make([]types.Highlight, 0, len(kept))
	for _, k := range kept {
		h := types.Highlight{
			Title: k.p.Title, Why: k.p.Why, StartSec: k.p.StartSec, EndSec: k.p.EndSec,
			PartID: k.p.Part.ID, PartStartSec: round1(k.p.StartSec - k.p.Part.StartSec),
			Score: k.score, Signals: Signals(moments, k.p.StartSec, k.p.EndSec),
		}
		for _, x := range sentences {
			if x.EndSec > k.p.StartSec {
				h.Quote = x.Text
				break
			}
		}
		out = append(out, h)
	}
	return out
}
