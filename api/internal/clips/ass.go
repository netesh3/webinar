package clips

import (
	"fmt"
	"math"
	"strings"
)

/* The burned-in text of a clip as an ASS script, which the video server's ffmpeg draws with
 * libass (the "ass" filter):
 *
 *   captions  big and bold, a few words at a time, the word being said in yellow
 *             (karaoke-style), the rest white with a black outline. One event per word, each
 *             showing the whole page with that word lit, so nothing moves as the highlight
 *             steps along.
 *   hook      the hook title in a dark box at the top for the first HookSec seconds, fading
 *             in and out.
 *
 * Laid out per format (PlayResX/Y is the frame, so sizes are pixels): on 9:16 the captions
 * sit below the middle (under the picture when it is fitted), clear of the buttons and the caption Reels, Shorts and TikTok
 * draw over the bottom third; on 1:1 and 16:9 they sit low. Fonts are Inter (bundled in the
 * renderer's image), any glyph it lacks from Noto through fontconfig. */

// Font is the family the script asks for.
const Font = "Inter"

// HookSec is how long the hook title stays up.
const HookSec = 2.8

// Colours, as ASS writes them (&HAABBGGRR, alpha 00 opaque).
const (
	white     = "&H00FFFFFF"
	black     = "&H00000000"
	yellow    = "&H0000D7FF" // #FFD700
	shadow    = "&H80000000"
	hookBox   = "&H33000000" // black, 80% opaque
	litColour = "&H00D7FF&"  // the \c override of yellow
	offColour = "&HFFFFFF&"
)

// layout is a format's text sizes and places, in pixels.
type layout struct {
	size                  Size
	capSize, capMarginV   int
	capOutline            int
	hookSize, hookMarginV int
	marginH               int
	maxChars              int // per caption page
}

func layoutFor(format string) (layout, bool) {
	size, ok := SizeOf(format)
	if !ok {
		return layout{}, false
	}
	switch {
	case size.H > size.W: // 9:16
		return layout{size: size, capSize: 88, capMarginV: 520, capOutline: 7,
			hookSize: 72, hookMarginV: 300, marginH: 90, maxChars: 18}, true
	case size.H == size.W: // 1:1
		return layout{size: size, capSize: 72, capMarginV: 150, capOutline: 6,
			hookSize: 60, hookMarginV: 90, marginH: 80, maxChars: 22}, true
	default: // 16:9
		return layout{size: size, capSize: 72, capMarginV: 90, capOutline: 6,
			hookSize: 64, hookMarginV: 70, marginH: 160, maxChars: 34}, true
	}
}

// ASSInput is what a clip's script is made from.
type ASSInput struct {
	Format string
	// Words are on the clip's clock (OnClip); none means no captions.
	Words []Word
	// Hook is the hook title; empty means none.
	Hook        string
	DurationSec float64
}

// ASS is the clip's script; empty when there is nothing to draw (no words and no hook) or the
// format is unknown.
func ASS(in ASSInput) string {
	lay, ok := layoutFor(in.Format)
	if !ok {
		return ""
	}
	hook := assText(in.Hook)
	if len(in.Words) == 0 && hook == "" {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n",
		lay.size.W, lay.size.H)
	b.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	fmt.Fprintf(&b, "Style: Caption,%s,%d,%s,%s,%s,%s,-1,0,0,0,100,100,0,0,1,%d,3,2,%d,%d,%d,1\n",
		Font, lay.capSize, white, yellow, black, shadow, lay.capOutline, lay.marginH, lay.marginH, lay.capMarginV)
	fmt.Fprintf(&b, "Style: Hook,%s,%d,%s,%s,%s,%s,-1,0,0,0,100,100,0,0,3,14,0,8,%d,%d,%d,1\n\n",
		Font, lay.hookSize, white, white, hookBox, hookBox, lay.marginH, lay.marginH, lay.hookMarginV)
	b.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")

	end := in.DurationSec
	if hook != "" {
		hookEnd := math.Min(HookSec, end)
		if hookEnd <= 0 {
			hookEnd = HookSec
		}
		fmt.Fprintf(&b, "Dialogue: 1,%s,%s,Hook,,0,0,0,,{\\fad(150,250)}%s\n", assTime(0), assTime(hookEnd), hook)
	}

	pages := Pages(in.Words, lay.maxChars)
	for p, page := range pages {
		pageEnd := page[len(page)-1].EndSec + 0.35
		if p+1 < len(pages) {
			pageEnd = math.Min(pageEnd, pages[p+1][0].StartSec)
		}
		if end > 0 {
			pageEnd = math.Min(pageEnd, end)
		}
		texts := make([]string, len(page))
		for i, w := range page {
			texts[i] = assText(w.Text)
		}
		for i, w := range page {
			start := w.StartSec
			stop := pageEnd
			if i+1 < len(page) {
				stop = page[i+1].StartSec
			}
			if stop-start < 0.01 {
				continue
			}
			var line strings.Builder
			for j, t := range texts {
				if j > 0 {
					line.WriteByte(' ')
				}
				if j == i {
					line.WriteString("{\\c" + litColour + "}" + t + "{\\c" + offColour + "}")
				} else {
					line.WriteString(t)
				}
			}
			fmt.Fprintf(&b, "Dialogue: 0,%s,%s,Caption,,0,0,0,,%s\n", assTime(start), assTime(stop), line.String())
		}
	}
	return b.String()
}

// assTime is H:MM:SS.cc.
func assTime(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	cs := int64(math.Round(sec * 100))
	h := cs / 360000
	m := cs / 6000 % 60
	s := cs / 100 % 60
	return fmt.Sprintf("%d:%02d:%02d.%02d", h, m, s, cs%100)
}

/* assText is text safe inside an event: on one line, with nothing libass would read as an
 * override block ({…}) or an escape (\N, \h …). */
func assText(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	return strings.NewReplacer("{", "(", "}", ")", `\`, "/").Replace(s)
}
