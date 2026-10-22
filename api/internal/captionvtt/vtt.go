// Package captionvtt turns a session's stored transcript into a WebVTT captions file for
// its recording: the CC on a replay and on a simulive of it, reusing the captions the
// original session already has rather than transcribing the video again.
//
// Pure: the API loads the lines and the recording's takes and hands them here.
package captionvtt

import (
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Line is one stretch of speech, wall-clock. End may be zero when only a moment is known.
type Line struct {
	Start   time.Time
	End     time.Time
	Speaker string // already shortened for display; "" for no label
	Text    string
}

// Take is one file of a recording: when it started and how long it is.
type Take struct {
	Start    time.Time
	Duration time.Duration
}

// Span is a take placed on the recording's playlist: wall-clock [Start, End), playing from
// Offset into the playlist.
type Span struct {
	Start  time.Time
	End    time.Time
	Offset time.Duration
}

/* Spans lays the takes out the way the player plays them, concatenated in order. It mirrors
 * web/lib/recap.ts chapterSeekTimes: each take starts at its own createdAt, but never before
 * the previous take ended, and sits in the playlist after the sum of the takes before it. */
func Spans(takes []Take) []Span {
	out := make([]Span, 0, len(takes))
	var offset time.Duration
	var prevEnd time.Time
	for _, t := range takes {
		d := max(t.Duration, 0)
		start := t.Start
		if !prevEnd.IsZero() && start.Before(prevEnd) {
			start = prevEnd
		}
		out = append(out, Span{Start: start, End: start.Add(d), Offset: offset})
		offset += d
		prevEnd = start.Add(d)
	}
	return out
}

// Cue is one caption on the playlist's timeline.
type Cue struct {
	Start time.Duration
	End   time.Duration
	Lines []string // one or two, each at most MaxLineRunes where words allow
}

const (
	// MaxLineRunes is the usual broadcast limit for one caption line.
	MaxLineRunes = 42
	// MaxCueLines is how many lines one caption shows at once.
	MaxCueLines = 2
	// mergeGap is how close two lines from one speaker must be to share a caption.
	mergeGap = 1200 * time.Millisecond
	minCue   = 1000 * time.Millisecond
	// A caption with no known length is given one by its reading time, within these.
	runesPerSec = 15
	minGuess    = 1200 * time.Millisecond
	maxGuess    = 6 * time.Second
)

// GuessDuration is how long a line with only one known moment was being said.
func GuessDuration(text string) time.Duration {
	d := time.Duration(utf8.RuneCountInString(text)) * time.Second / runesPerSec
	return min(max(d, minGuess), maxGuess)
}

type placed struct {
	start, end time.Duration
	speaker    string
	text       string
}

/* Build is the captions for lines on the playlist that spans describe.
 *
 * A line is placed in the take it starts in, at the same moment in it; one that starts just
 * before a take (the recording was pressed mid-sentence) starts with the take instead. A line
 * outside every take is not in the recording and is dropped. Consecutive short lines from one
 * speaker are merged, and anything longer than two lines is split into several captions over
 * its time, in proportion to the words. The speaker's name leads a caption when the speaker
 * changes. */
func Build(lines []Line, spans []Span) []Cue {
	if len(spans) == 0 {
		return nil
	}
	ps := make([]placed, 0, len(lines))
	for _, l := range lines {
		text := clean(l.Text)
		if text == "" {
			continue
		}
		end := l.End
		if end.IsZero() || !end.After(l.Start) {
			end = l.Start.Add(GuessDuration(text))
		}
		for _, sp := range spans {
			if !end.After(sp.Start) || !l.Start.Before(sp.End) {
				continue
			}
			s := l.Start
			if s.Before(sp.Start) {
				s = sp.Start
			}
			e := end
			if e.After(sp.End) {
				e = sp.End
			}
			ps = append(ps, placed{
				start:   sp.Offset + s.Sub(sp.Start),
				end:     sp.Offset + e.Sub(sp.Start),
				speaker: strings.TrimSpace(l.Speaker),
				text:    text,
			})
			break
		}
	}
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].start < ps[j].start })

	// Merge runs of one speaker's short lines.
	merged := make([]placed, 0, len(ps))
	for _, p := range ps {
		if n := len(merged); n > 0 {
			last := &merged[n-1]
			joined := last.text + " " + p.text
			if last.speaker == p.speaker && p.start-last.end <= mergeGap &&
				utf8.RuneCountInString(labelled(last.speaker, joined)) <= MaxLineRunes*MaxCueLines {
				last.text = joined
				last.end = max(last.end, p.end)
				continue
			}
		}
		merged = append(merged, p)
	}

	var cues []Cue
	prevSpeaker := "\x00"
	for _, p := range merged {
		text := p.text
		if p.speaker != prevSpeaker && p.speaker != "" {
			text = labelled(p.speaker, text)
		}
		prevSpeaker = p.speaker
		chunks := chunk(wrap(text, MaxLineRunes), MaxCueLines)
		total := 0
		for _, c := range chunks {
			total += runes(c)
		}
		dur := max(p.end-p.start, minCue)
		at := p.start
		for i, c := range chunks {
			d := dur
			if total > 0 {
				d = dur * time.Duration(runes(c)) / time.Duration(total)
			}
			end := at + d
			if i == len(chunks)-1 {
				end = p.start + dur
			}
			cues = append(cues, Cue{Start: at, End: end, Lines: c})
			at = end
		}
	}

	// Two speakers at once would stack into more than two lines: a caption gives way to the
	// next one, but is never cut shorter than a beat.
	for i := 0; i+1 < len(cues); i++ {
		if next := cues[i+1].Start; cues[i].End > next {
			cues[i].End = max(next, cues[i].Start+300*time.Millisecond)
		}
	}
	return cues
}

func labelled(speaker, text string) string {
	if speaker == "" {
		return text
	}
	return speaker + ": " + text
}

func runes(lines []string) int {
	n := 0
	for _, l := range lines {
		n += utf8.RuneCountInString(l)
	}
	return n
}

// clean collapses whitespace and drops control characters: a cue's text is one paragraph.
func clean(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// wrap breaks text into lines of at most width runes at spaces; a longer word is cut.
func wrap(text string, width int) []string {
	var out []string
	var cur []rune
	for _, w := range strings.Fields(text) {
		wr := []rune(w)
		for len(wr) > width {
			if len(cur) > 0 {
				out = append(out, string(cur))
				cur = nil
			}
			out = append(out, string(wr[:width]))
			wr = wr[width:]
		}
		switch {
		case len(cur) == 0:
			cur = append(cur, wr...)
		case len(cur)+1+len(wr) <= width:
			cur = append(append(cur, ' '), wr...)
		default:
			out = append(out, string(cur))
			cur = append([]rune(nil), wr...)
		}
	}
	if len(cur) > 0 {
		out = append(out, string(cur))
	}
	return out
}

func chunk(lines []string, n int) [][]string {
	var out [][]string
	for i := 0; i < len(lines); i += n {
		out = append(out, lines[i:min(i+n, len(lines))])
	}
	return out
}

// Render writes cues as a WebVTT file. Text is escaped: & < > are markup in a cue.
func Render(cues []Cue) string {
	var b strings.Builder
	b.WriteString("WEBVTT\n")
	for i, c := range cues {
		b.WriteString("\n")
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteString("\n")
		b.WriteString(Timestamp(c.Start))
		b.WriteString(" --> ")
		b.WriteString(Timestamp(c.End))
		b.WriteString("\n")
		for _, l := range c.Lines {
			b.WriteString(escape(l))
			b.WriteString("\n")
		}
	}
	return b.String()
}

var escaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func escape(s string) string { return escaper.Replace(s) }

// Timestamp is a WebVTT time, HH:MM:SS.mmm.
func Timestamp(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	ms := d.Milliseconds()
	h := ms / 3_600_000
	m := ms / 60_000 % 60
	s := ms / 1000 % 60
	pad := func(n int64, w int) string {
		str := strconv.FormatInt(n, 10)
		for len(str) < w {
			str = "0" + str
		}
		return str
	}
	return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "." + pad(ms%1000, 3)
}

/* FirstName is how a speaker is labelled: "Priya Sharma" → "Priya". Empty when the name is
 * really contact details (an email or a phone number typed into the name field), so the
 * caller labels the line by role instead. */
func FirstName(name string) string {
	f := strings.Fields(name)
	if len(f) == 0 {
		return ""
	}
	first := f[0]
	if strings.ContainsRune(first, '@') {
		return ""
	}
	digits := 0
	for _, r := range first {
		if unicode.IsDigit(r) {
			digits++
		}
	}
	if digits > 0 {
		return ""
	}
	if r := []rune(first); len(r) > 24 {
		first = string(r[:24])
	}
	return first
}
