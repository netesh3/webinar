package captionvtt

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var t0 = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)

func at(sec float64) time.Time { return t0.Add(time.Duration(sec * float64(time.Second))) }

func secs(d time.Duration) float64 { return d.Seconds() }

func TestSpansMirrorChapterLayout(t *testing.T) {
	// Two takes with a five-minute gap; a third that claims to start inside the second.
	spans := Spans([]Take{
		{Start: at(60), Duration: 10 * time.Minute},
		{Start: at(900), Duration: 5 * time.Minute},
		{Start: at(1100), Duration: time.Minute},
	})
	if len(spans) != 3 {
		t.Fatalf("spans = %d", len(spans))
	}
	if !spans[0].Start.Equal(at(60)) || spans[0].Offset != 0 {
		t.Fatalf("take 1 = %+v", spans[0])
	}
	if !spans[1].Start.Equal(at(900)) || spans[1].Offset != 10*time.Minute {
		t.Fatalf("take 2 = %+v", spans[1])
	}
	// Never before the previous take ended.
	if !spans[2].Start.Equal(at(1200)) || spans[2].Offset != 15*time.Minute {
		t.Fatalf("take 3 = %+v", spans[2])
	}
}

func TestTimingAcrossTakesAndDrops(t *testing.T) {
	spans := Spans([]Take{
		{Start: at(60), Duration: 10 * time.Minute}, // 60..660 → 0..600
		{Start: at(900), Duration: 5 * time.Minute}, // 900..1200 → 600..900
	})
	cues := Build([]Line{
		{Start: at(10), End: at(14), Speaker: "Asha", Text: "before the recording"},
		{Start: at(58), End: at(63), Speaker: "Asha", Text: "straddles the start"},
		{Start: at(120), End: at(124), Speaker: "Priya", Text: "inside take one"},
		{Start: at(700), End: at(703), Speaker: "Asha", Text: "in the gap"},
		{Start: at(905), End: at(908), Speaker: "Asha", Text: "inside take two"},
		{Start: at(1300), End: at(1302), Speaker: "Asha", Text: "after the end"},
	}, spans)
	if len(cues) != 3 {
		t.Fatalf("cues = %+v", cues)
	}
	want := []struct {
		start, end float64
		text       string
	}{
		{0, 3, "Asha: straddles the start"},
		{60, 64, "Priya: inside take one"},
		{605, 608, "Asha: inside take two"},
	}
	for i, w := range want {
		c := cues[i]
		if secs(c.Start) != w.start || secs(c.End) != w.end || strings.Join(c.Lines, " ") != w.text {
			t.Errorf("cue %d = %v-%v %q, want %v-%v %q", i, secs(c.Start), secs(c.End), c.Lines, w.start, w.end, w.text)
		}
	}
}

func TestPartLocalTimeline(t *testing.T) {
	spans := Spans([]Take{{Start: at(60), Duration: 10 * time.Minute}, {Start: at(900), Duration: time.Minute}})
	second := spans[1]
	second.Offset = 0
	cues := Build([]Line{{Start: at(905), End: at(907), Text: "hello"}}, []Span{second})
	if len(cues) != 1 || secs(cues[0].Start) != 5 {
		t.Fatalf("cues = %+v", cues)
	}
}

func TestMergeAndSplit(t *testing.T) {
	spans := Spans([]Take{{Start: at(0), Duration: time.Hour}})
	cues := Build([]Line{
		{Start: at(1), End: at(2), Speaker: "Asha", Text: "Namaste"},
		{Start: at(2.5), End: at(3.5), Speaker: "Asha", Text: "sab log"},
		{Start: at(4), End: at(5), Speaker: "Priya", Text: "Hi"},
	}, spans)
	if len(cues) != 2 || strings.Join(cues[0].Lines, " ") != "Asha: Namaste sab log" || secs(cues[0].End) != 3.5 {
		t.Fatalf("merge: %+v", cues)
	}

	long := strings.Repeat("aaj hum baat karenge ", 12) // ~250 runes
	cues = Build([]Line{{Start: at(10), End: at(30), Speaker: "Asha", Text: long}}, spans)
	if len(cues) < 3 {
		t.Fatalf("split: %d cues", len(cues))
	}
	for i, c := range cues {
		if len(c.Lines) > MaxCueLines {
			t.Fatalf("cue %d has %d lines", i, len(c.Lines))
		}
		for _, l := range c.Lines {
			if utf8.RuneCountInString(l) > MaxLineRunes {
				t.Fatalf("line %q is %d runes", l, utf8.RuneCountInString(l))
			}
		}
		if i > 0 && c.Start != cues[i-1].End {
			t.Fatalf("cue %d starts at %v, previous ended %v", i, c.Start, cues[i-1].End)
		}
	}
	if !strings.HasPrefix(cues[0].Lines[0], "Asha: ") || strings.HasPrefix(cues[1].Lines[0], "Asha") {
		t.Fatalf("speaker label should lead the turn only: %q / %q", cues[0].Lines, cues[1].Lines)
	}
	if secs(cues[0].Start) != 10 || secs(cues[len(cues)-1].End) != 30 {
		t.Fatalf("split spans %v..%v", cues[0].Start, cues[len(cues)-1].End)
	}
}

func TestOverlapGivesWay(t *testing.T) {
	spans := Spans([]Take{{Start: at(0), Duration: time.Hour}})
	cues := Build([]Line{
		{Start: at(1), End: at(6), Speaker: "Asha", Text: "one"},
		{Start: at(3), End: at(5), Speaker: "Priya", Text: "two"},
	}, spans)
	if len(cues) != 2 || cues[0].End != cues[1].Start {
		t.Fatalf("cues = %+v", cues)
	}
}

func TestGuessedDurationAndMinimum(t *testing.T) {
	spans := Spans([]Take{{Start: at(0), Duration: time.Hour}})
	cues := Build([]Line{{Start: at(1), Text: "haan ji"}}, spans)
	if len(cues) != 1 || cues[0].End-cues[0].Start < minGuess {
		t.Fatalf("cues = %+v", cues)
	}
}

func TestRenderEscapesAndFormats(t *testing.T) {
	out := Render([]Cue{
		{Start: 3723*time.Second + 45*time.Millisecond, End: 3725 * time.Second, Lines: []string{"Asha: a < b && c > d", "x --> y"}},
	})
	want := "WEBVTT\n\n1\n01:02:03.045 --> 01:02:05.000\nAsha: a &lt; b &amp;&amp; c &gt; d\nx --&gt; y\n"
	if out != want {
		t.Fatalf("got\n%s\nwant\n%s", out, want)
	}
	// A line with a newline in it is one paragraph.
	cues := Build([]Line{{Start: at(1), End: at(2), Text: "kya\nbaat\t hai"}}, Spans([]Take{{Start: at(0), Duration: time.Minute}}))
	if strings.Join(cues[0].Lines, "|") != "kya baat hai" {
		t.Fatalf("clean: %q", cues[0].Lines)
	}
}

func TestFirstName(t *testing.T) {
	for in, want := range map[string]string{
		"Priya Sharma":             "Priya",
		"  Asha  ":                 "Asha",
		"":                         "",
		"priya.sharma@example.com": "",
		"9876543210":               "",
		"Rahul":                    "Rahul",
	} {
		if got := FirstName(in); got != want {
			t.Errorf("FirstName(%q) = %q, want %q", in, got, want)
		}
	}
}
