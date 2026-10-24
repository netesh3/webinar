package clips

import (
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/highlights"
	"github.com/netkumar/webcast/api/types"
)

var twoTakes = []highlights.Part{{ID: "a", StartSec: 0, EndSec: 600}, {ID: "b", StartSec: 600, EndSec: 900}}

func TestSegmentsPlaceRangesInTheirTakes(t *testing.T) {
	segs, err := Segments([]types.ClipRange{{StartSec: 100, EndSec: 130}, {StartSec: 650, EndSec: 662.5}}, twoTakes)
	if err != nil {
		t.Fatal(err)
	}
	want := []Segment{
		{PartID: "a", PlayerStart: 100, PlayerEnd: 130, FileStart: 100},
		{PartID: "b", PlayerStart: 650, PlayerEnd: 662.5, FileStart: 50},
	}
	for i := range want {
		if segs[i] != want[i] {
			t.Fatalf("segment %d = %+v, want %+v", i, segs[i], want[i])
		}
	}
	if Total(segs) != 42.5 {
		t.Fatalf("total = %v", Total(segs))
	}
}

func TestSegmentsRefuse(t *testing.T) {
	cases := map[string]struct {
		r    types.ClipRange
		want error
	}{
		"across a break": {types.ClipRange{StartSec: 590, EndSec: 610}, ErrRangeAcross},
		"backwards":      {types.ClipRange{StartSec: 50, EndSec: 40}, ErrRangeBackward},
		"outside":        {types.ClipRange{StartSec: 950, EndSec: 960}, ErrRangeOutside},
	}
	for name, c := range cases {
		if _, err := Segments([]types.ClipRange{c.r}, twoTakes); err != c.want {
			t.Errorf("%s: err = %v, want %v", name, err, c.want)
		}
	}
	if _, err := Segments(nil, twoTakes); err != ErrNoRange {
		t.Errorf("no range: %v", err)
	}
	// A quarter second over a take's edge is clamped, not refused.
	segs, err := Segments([]types.ClipRange{{StartSec: 580, EndSec: 600.2}}, twoTakes)
	if err != nil || segs[0].PlayerEnd != 600 {
		t.Fatalf("edge: %+v %v", segs, err)
	}
}

func m(start, end float64) types.ReelMoment { return types.ReelMoment{StartSec: start, EndSec: end} }

func TestReelRules(t *testing.T) {
	// Fine as it is: 3 moments, 45 s.
	kept, total, ok := Reel([]types.ReelMoment{m(10, 25), m(100, 115), m(300, 315)})
	if !ok || len(kept) != 3 || total != 45 {
		t.Fatalf("kept %v total %v ok %v", kept, total, ok)
	}
	// An overlapping moment is dropped; one moment left is no reel.
	if _, _, ok := Reel([]types.ReelMoment{m(10, 30), m(20, 40)}); ok {
		t.Fatal("one moment made a reel")
	}
	// Over 75 s: the last moments go, down to two, then the last is shortened.
	kept, total, ok = Reel([]types.ReelMoment{m(0, 25), m(100, 125), m(200, 225), m(300, 325), m(400, 425)})
	if !ok || len(kept) != 3 || total != 75 {
		t.Fatalf("long: kept %v total %v ok %v", kept, total, ok)
	}
	kept, total, ok = Reel([]types.ReelMoment{m(0, 40), m(100, 140)})
	if !ok || total != 75 || kept[1].EndSec != 135 {
		t.Fatalf("shortened: kept %v total %v ok %v", kept, total, ok)
	}
	// Under 20 s in all: no reel.
	if _, _, ok := Reel([]types.ReelMoment{m(0, 6), m(10, 16)}); ok {
		t.Fatal("a 12 s reel")
	}
}

func TestWordsShareALineByLength(t *testing.T) {
	words := Words([]Line{{StartSec: 10, EndSec: 12, Text: "I am delighted"}})
	// Weights 2, 3, 10 of 15 over 2 s.
	want := []Word{{10, 10.27, "I"}, {10.27, 10.67, "am"}, {10.67, 12, "delighted"}}
	if len(words) != len(want) {
		t.Fatalf("words = %+v", words)
	}
	for i := range want {
		if words[i] != want[i] {
			t.Fatalf("word %d = %+v, want %+v", i, words[i], want[i])
		}
	}
	// No end: a guess, cut short by the next line.
	words = Words([]Line{{StartSec: 0, Text: "one two three four"}, {StartSec: 1, EndSec: 2, Text: "next"}})
	if words[3].EndSec != 1 {
		t.Fatalf("guessed end = %+v", words[3])
	}
	// Word timings from the source are kept as they are.
	given := []Word{{1, 1.5, "hello"}}
	if got := Words([]Line{{StartSec: 0, EndSec: 9, Text: "hello", Words: given}}); got[0] != given[0] {
		t.Fatalf("given words = %+v", got)
	}
}

func TestOnClipMovesWordsOntoTheClipClock(t *testing.T) {
	words := []Word{{99, 99.4, "before"}, {100.1, 100.5, "first"}, {129.5, 130.3, "edge"}, {650, 650.4, "second"}}
	segs := []Segment{{PartID: "a", PlayerStart: 100, PlayerEnd: 130}, {PartID: "b", PlayerStart: 650, PlayerEnd: 660}}
	got := OnClip(words, segs)
	want := []Word{{0.1, 0.5, "first"}, {29.5, 30, "edge"}, {30, 30.4, "second"}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("word %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPagesBreakOnLengthSentencesAndPauses(t *testing.T) {
	w := func(s, e float64, t string) Word { return Word{s, e, t} }
	pages := Pages([]Word{
		w(0, .3, "Price"), w(.3, .6, "by"), w(.6, 1, "value."), // sentence end
		w(1, 1.3, "Not"), w(1.3, 1.6, "by"), // pause after
		w(3, 3.3, "the"), w(3.3, 3.8, "hour"), w(3.8, 4.5, "everybody"), // 17 chars a page
	}, 17)
	got := make([]string, len(pages))
	for i, p := range pages {
		var ws []string
		for _, x := range p {
			ws = append(ws, x.Text)
		}
		got[i] = strings.Join(ws, " ")
	}
	want := []string{"Price by value.", "Not by", "the hour", "everybody"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("pages = %q, want %q", got, want)
	}
}

func TestASSGolden(t *testing.T) {
	got := ASS(ASSInput{
		Format:      types.ClipFormatVertical,
		Words:       []Word{{0.2, 0.5, "Price"}, {0.5, 0.8, "by"}, {0.8, 1.4, "{value}."}, {1.5, 2, "Always"}},
		Hook:        "Stop charging by the hour",
		DurationSec: 2.2,
	})
	want := `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Inter,88,&H00FFFFFF,&H0000D7FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,3,2,90,90,520,1
Style: Hook,Inter,72,&H00FFFFFF,&H00FFFFFF,&H33000000,&H33000000,-1,0,0,0,100,100,0,0,3,14,0,8,90,90,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,0:00:00.00,0:00:02.20,Hook,,0,0,0,,{\fad(150,250)}Stop charging by the hour
Dialogue: 0,0:00:00.20,0:00:00.50,Caption,,0,0,0,,{\c&H00D7FF&}Price{\c&HFFFFFF&} by (value).
Dialogue: 0,0:00:00.50,0:00:00.80,Caption,,0,0,0,,Price {\c&H00D7FF&}by{\c&HFFFFFF&} (value).
Dialogue: 0,0:00:00.80,0:00:01.50,Caption,,0,0,0,,Price by {\c&H00D7FF&}(value).{\c&HFFFFFF&}
Dialogue: 0,0:00:01.50,0:00:02.20,Caption,,0,0,0,,{\c&H00D7FF&}Always{\c&HFFFFFF&}
`
	if got != want {
		t.Fatalf("ASS =\n%s\nwant\n%s", got, want)
	}
}

func TestASSFormatsAndNothing(t *testing.T) {
	if ASS(ASSInput{Format: types.ClipFormatWide}) != "" {
		t.Fatal("a script with nothing in it")
	}
	if ASS(ASSInput{Format: "4x3", Hook: "x"}) != "" {
		t.Fatal("a script for an unknown format")
	}
	sq := ASS(ASSInput{Format: types.ClipFormatSquare, Hook: "Hi", DurationSec: 30})
	if !strings.Contains(sq, "PlayResX: 1080\nPlayResY: 1080") || !strings.Contains(sq, "0:00:02.80,Hook") {
		t.Fatalf("square:\n%s", sq)
	}
	wide := ASS(ASSInput{Format: types.ClipFormatWide, Words: []Word{{0, 1, `a\Nb`}}, DurationSec: 5})
	if !strings.Contains(wide, "PlayResX: 1920") || strings.Contains(wide, `\N`) {
		t.Fatalf("wide:\n%s", wide)
	}
}

func TestASSTime(t *testing.T) {
	for sec, want := range map[float64]string{0: "0:00:00.00", 61.257: "0:01:01.26", 3725.5: "1:02:05.50", -1: "0:00:00.00"} {
		if got := assTime(sec); got != want {
			t.Errorf("assTime(%v) = %s, want %s", sec, got, want)
		}
	}
}
