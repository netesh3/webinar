/* Package clips is the arithmetic of a clip or reel cut from a session's recording: where its
 * stretches lie in the recording's files (Segments), the rules a reel keeps (Reel), the words
 * said in it on the clip's own clock (Words, OnClip) and the burned-in captions and hook title
 * as an ASS script for libass (ASS). The video server renders from what this produces
 * (deploy/livekit-hetzner/mixrec/clips.go).
 *
 * Times are seconds: on the recording's player timeline (its takes end to end, as
 * internal/highlights has them) going in, on the clip's own clock (0 at its first frame)
 * coming out.
 *
 * Pure: no database, no clock, no model. */
package clips

import (
	"errors"
	"math"

	"github.com/netkumar/webcast/api/internal/highlights"
	"github.com/netkumar/webcast/api/types"
)

// Size is a format's frame in pixels.
type Size struct{ W, H int }

// SizeOf is the frame of a format; false for one that is not a format.
func SizeOf(format string) (Size, bool) {
	switch format {
	case types.ClipFormatVertical:
		return Size{1080, 1920}, true
	case types.ClipFormatSquare:
		return Size{1080, 1080}, true
	case types.ClipFormatWide:
		return Size{1920, 1080}, true
	}
	return Size{}, false
}

// ValidFraming reports whether f is one of the framings.
func ValidFraming(f string) bool {
	switch f {
	case types.ClipFramingFit, types.ClipFramingCenter, types.ClipFramingLeft, types.ClipFramingRight:
		return true
	}
	return false
}

/* Segment is one stretch of the recording in a clip: where it lies on the player timeline,
 * the take (PartID) it is cut from, and where it starts in that take's own file. */
type Segment struct {
	PartID      string  `json:"partId"`
	PlayerStart float64 `json:"playerStart"`
	PlayerEnd   float64 `json:"playerEnd"`
	FileStart   float64 `json:"fileStart"`
}

// Duration is the segment's length.
func (s Segment) Duration() float64 { return s.PlayerEnd - s.PlayerStart }

// Plain-words refusals of Segments.
var (
	ErrNoRange       = errors.New("Pick a stretch of the recording first.")
	ErrRangeBackward = errors.New("A stretch has to end after it starts.")
	ErrRangeAcross   = errors.New("Each stretch has to lie inside one part of the recording; this one runs across a break in the recording.")
	ErrRangeOutside  = errors.New("A stretch lies outside the recording.")
)

/* Segments places ranges (player timeline, in the order they play) in the recording's takes.
 * Each must lie inside one take, give or take a quarter second at its edges, which is
 * clamped off. */
func Segments(ranges []types.ClipRange, parts []highlights.Part) ([]Segment, error) {
	if len(ranges) == 0 {
		return nil, ErrNoRange
	}
	out := make([]Segment, 0, len(ranges))
	for _, r := range ranges {
		if math.IsNaN(r.StartSec) || math.IsNaN(r.EndSec) || r.EndSec <= r.StartSec {
			return nil, ErrRangeBackward
		}
		var part highlights.Part
		found := false
		for _, p := range parts {
			if r.StartSec >= p.StartSec-0.25 && r.StartSec < p.EndSec {
				part, found = p, true
				break
			}
		}
		if !found {
			return nil, ErrRangeOutside
		}
		if r.EndSec > part.EndSec+0.25 {
			return nil, ErrRangeAcross
		}
		start := math.Max(r.StartSec, part.StartSec)
		end := math.Min(r.EndSec, part.EndSec)
		if end-start < 0.5 {
			return nil, ErrRangeBackward
		}
		out = append(out, Segment{
			PartID: part.ID, PlayerStart: round2(start), PlayerEnd: round2(end),
			FileStart: round2(start - part.StartSec),
		})
	}
	return out, nil
}

// Total is the clip's length: its segments end to end.
func Total(segs []Segment) float64 {
	var t float64
	for _, s := range segs {
		t += s.Duration()
	}
	return round2(t)
}

/* Reel keeps a reel's moments to the rules: no moment overlapping one before it, at most
 * ReelMaxMoments, and no longer than ReelMaxSec in all (moments dropped from the end, then
 * the last one shortened). False when what is left is fewer than ReelMinMoments or shorter
 * than ReelMinSec. */
func Reel(moments []types.ReelMoment) ([]types.ReelMoment, float64, bool) {
	var kept []types.ReelMoment
	for _, m := range moments {
		if m.EndSec-m.StartSec < 1 {
			continue
		}
		clash := false
		for _, k := range kept {
			if m.StartSec < k.EndSec && k.StartSec < m.EndSec {
				clash = true
				break
			}
		}
		if !clash {
			kept = append(kept, m)
		}
		if len(kept) == types.ReelMaxMoments {
			break
		}
	}
	total := func() float64 {
		var t float64
		for _, k := range kept {
			t += k.EndSec - k.StartSec
		}
		return t
	}
	for total() > types.ReelMaxSec && len(kept) > types.ReelMinMoments {
		kept = kept[:len(kept)-1]
	}
	if over := total() - types.ReelMaxSec; over > 0 {
		last := &kept[len(kept)-1]
		if last.EndSec-last.StartSec-over < types.ReelMomentMinSec {
			return nil, 0, false
		}
		last.EndSec = round2(last.EndSec - over)
	}
	if len(kept) < types.ReelMinMoments || total() < types.ReelMinSec {
		return nil, 0, false
	}
	return kept, round2(total()), true
}

func round2(x float64) float64 { return math.Round(x*100) / 100 }
