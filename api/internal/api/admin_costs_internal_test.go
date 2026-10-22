package api

import (
	"math"
	"net/url"
	"testing"
	"time"

	"github.com/netkumar/webcast/api/internal/store"
)

func TestSplitConcurrency(t *testing.T) {
	at := func(h float64) time.Time {
		return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(h * float64(time.Hour)))
	}
	spans := []store.CostSpan{
		{WebinarID: "a", Project: "p", Edge: true, Start: at(0), End: at(2)},
		{WebinarID: "b", Project: "p", Edge: true, Start: at(1), End: at(3)},
		{WebinarID: "c", Project: "p", Edge: false, Start: at(1), End: at(2)},
		// Another server: alone, however it overlaps the others in time.
		{WebinarID: "d", Project: "q", Edge: true, Start: at(0), End: at(3)},
		// Touches a's end: no overlap.
		{WebinarID: "e", Project: "p", Edge: false, Start: at(3), End: at(4)},
	}
	got := splitConcurrency(spans, time.Time{}, at(10))
	near := func(what string, g, w float64) {
		t.Helper()
		if math.Abs(g-w) > 1e-9 {
			t.Errorf("%s = %v, want %v", what, g, w)
		}
	}
	// 0–1 a alone; 1–2 a, b, c; 2–3 b alone; 3–4 e alone.
	near("a box", got["a"].box, 1+1.0/3)
	near("b box", got["b"].box, 1.0/3+1)
	near("c box", got["c"].box, 1.0/3)
	near("d box", got["d"].box, 3)
	near("e box", got["e"].box, 1)
	// 1–2 two Edge mixes: one extra render, half each; c is not Edge.
	near("a extra", got["a"].edgeExtra, 0.5)
	near("b extra", got["b"].edgeExtra, 0.5)
	near("c extra", got["c"].edgeExtra, 0)
	near("d extra", got["d"].edgeExtra, 0)

	// Clipped to a window: only 1.5–2.5 counts.
	clip := splitConcurrency(spans, at(1.5), at(2.5))
	near("a clipped", clip["a"].box, 0.5/3)
	near("b clipped", clip["b"].box, 0.5/3+0.5)
}

func TestParseCostRange(t *testing.T) {
	q := url.Values{"from": {"2026-09-01"}, "to": {"2026-09-30"}}
	_, _, lo, hi, err := parseCostRange(q)
	if err != nil {
		t.Fatal(err)
	}
	if lo.UTC().Format(time.RFC3339) != "2026-08-31T18:30:00Z" || hi.UTC().Format(time.RFC3339) != "2026-09-30T18:30:00Z" {
		t.Errorf("range = %v – %v", lo.UTC(), hi.UTC())
	}
	if _, _, _, _, err := parseCostRange(url.Values{"from": {"Sept"}}); err == nil {
		t.Error("bad from accepted")
	}
	// A range ending in the future stops at now.
	_, _, _, hi, _ = parseCostRange(url.Values{"to": {"2999-01-01"}})
	if hi.After(time.Now().Add(2 * time.Minute)) {
		t.Errorf("future end = %v", hi)
	}
}
