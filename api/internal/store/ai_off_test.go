package store

import (
	"testing"
	"time"
)

func TestAIOffWindowsContainAndCount(t *testing.T) {
	t0 := time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	ws := AIOffWindows{
		{From: t0, To: t0.Add(90 * time.Second)},
		{From: t0.Add(10 * time.Minute)}, // still open
	}
	for _, c := range []struct {
		at   time.Time
		want bool
	}{
		{t0.Add(-time.Millisecond), false},
		{t0, true}, // from is inclusive
		{t0.Add(89 * time.Second), true},
		{t0.Add(90 * time.Second), false}, // to is exclusive
		{t0.Add(5 * time.Minute), false},
		{t0.Add(10 * time.Minute), true},
		{t0.Add(5 * time.Hour), true},
	} {
		if got := ws.Contains(c.at); got != c.want {
			t.Errorf("Contains(%s) = %v, want %v", c.at.Sub(t0), got, c.want)
		}
	}
	if !ws.ContainsMs(t0.Add(time.Second).UnixMilli()) || ws.ContainsMs(t0.Add(2*time.Minute).UnixMilli()) {
		t.Error("ContainsMs disagrees with Contains")
	}
	// 1.5 min closed + 2 min open so far = 3.5, rounded up.
	if got := ws.Minutes(t0.Add(12 * time.Minute)); got != 4 {
		t.Errorf("Minutes = %d, want 4", got)
	}
	if got := (AIOffWindows{{From: t0, To: t0.Add(time.Millisecond)}}).Minutes(t0); got != 1 {
		t.Errorf("a blip = %d min, want 1", got)
	}
	if got := AIOffWindows(nil).Minutes(t0); got != 0 || AIOffWindows(nil).Contains(t0) {
		t.Errorf("no windows = %d min", got)
	}
}
