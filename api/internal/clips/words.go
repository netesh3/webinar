package clips

import (
	"strings"
	"unicode/utf8"
)

/* The words said in a clip, each with its own time, for word-by-word captions.
 *
 * No transcript here has word timings: the after-session transcript (faster-whisper) and the
 * live captions both time whole lines. So a line's time is shared out among its words by
 * length (a word's characters plus one for the space after it), which tracks speech closely
 * enough for a highlight to land on the word being said. A transcript with word timings would
 * fill Line.Words and be used as it is. */

// Line is one caption line on the player timeline. Words, when the source has them, are its
// words with their own times (player timeline too).
type Line struct {
	StartSec, EndSec float64
	Text             string
	Words            []Word
}

// Word is one word and when it is said.
type Word struct {
	StartSec, EndSec float64
	Text             string
}

// secPerWordGuess is the length given to a line with no end time: about 160 words a minute.
const secPerWordGuess = 0.38

// Words is every word of lines, timed; lines are oldest first.
func Words(lines []Line) []Word {
	var out []Word
	for i, l := range lines {
		if len(l.Words) > 0 {
			out = append(out, l.Words...)
			continue
		}
		tokens := strings.Fields(l.Text)
		if len(tokens) == 0 {
			continue
		}
		start, end := l.StartSec, l.EndSec
		if end <= start {
			end = start + secPerWordGuess*float64(len(tokens))
			if i+1 < len(lines) && lines[i+1].StartSec > start && lines[i+1].StartSec < end {
				end = lines[i+1].StartSec
			}
		}
		weights := make([]int, len(tokens))
		sum := 0
		for j, t := range tokens {
			weights[j] = utf8.RuneCountInString(t) + 1
			sum += weights[j]
		}
		span := end - start
		at := start
		for j, t := range tokens {
			d := span * float64(weights[j]) / float64(sum)
			out = append(out, Word{StartSec: round2(at), EndSec: round2(at + d), Text: t})
			at += d
		}
	}
	return out
}

/* OnClip is the words said inside the clip's segments, moved onto the clip's own clock: a word
 * belongs to a segment when its middle lies inside it, and is clamped to the segment's edges. */
func OnClip(words []Word, segs []Segment) []Word {
	var out []Word
	var offset float64
	for _, s := range segs {
		for _, w := range words {
			mid := (w.StartSec + w.EndSec) / 2
			if mid < s.PlayerStart || mid >= s.PlayerEnd {
				continue
			}
			start := max(w.StartSec, s.PlayerStart) - s.PlayerStart + offset
			end := min(w.EndSec, s.PlayerEnd) - s.PlayerStart + offset
			out = append(out, Word{StartSec: round2(start), EndSec: round2(end), Text: w.Text})
		}
		offset += s.Duration()
	}
	return out
}

/* Pages groups words into what is on screen at once: at most maxChars (spaces counted), a
 * new page after a sentence ends or a pause of pageGap, and at a cut (a word starting where
 * the one before could not have run on). */
func Pages(words []Word, maxChars int) [][]Word {
	var pages [][]Word
	var cur []Word
	chars := 0
	for _, w := range words {
		n := utf8.RuneCountInString(w.Text)
		if len(cur) > 0 {
			prev := cur[len(cur)-1]
			if chars+1+n > maxChars || endsSentence(prev.Text) || w.StartSec-prev.EndSec > pageGap {
				pages = append(pages, cur)
				cur, chars = nil, 0
			}
		}
		if len(cur) > 0 {
			chars++
		}
		cur = append(cur, w)
		chars += n
	}
	if len(cur) > 0 {
		pages = append(pages, cur)
	}
	return pages
}

// pageGap is the pause that starts a new page.
const pageGap = 0.7

func endsSentence(word string) bool {
	word = strings.TrimRight(word, `"')]”’`)
	return strings.HasSuffix(word, ".") || strings.HasSuffix(word, "?") || strings.HasSuffix(word, "!")
}
