package engage

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Each number has its own bucket, and the instance's caps them all together.
func TestWALimitsPerNumberAndGlobal(t *testing.T) {
	const perSec = 50
	timed := func(numbers []string, each int) time.Duration {
		l := newWALimits(perSec)
		start := time.Now()
		var wg sync.WaitGroup
		for _, n := range numbers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range each {
					if err := l.wait(context.Background(), n); err != nil {
						t.Error(err)
						return
					}
				}
			}()
		}
		wg.Wait()
		return time.Since(start)
	}
	// One number, 100 sends: a burst of 50, then 50 at 50/s, about 1 s.
	if d := timed([]string{"a"}, 100); d < 900*time.Millisecond || d > 1600*time.Millisecond {
		t.Errorf("one number, 100 sends at %d/s took %v, want about 1 s", perSec, d)
	}
	// Two numbers, 100 each: each number alone allows that in 1 s, but the instance's
	// 50/s makes 200 take about 3 s.
	if d := timed([]string{"a", "b"}, 100); d < 2800*time.Millisecond {
		t.Errorf("two numbers, 200 sends took %v, want about 3 s: the instance cap did not hold", d)
	}
}

func TestWALimitsWaitStopsAtTheDeadline(t *testing.T) {
	l := newWALimits(5)
	for range 5 {
		_ = l.wait(context.Background(), "a")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := l.wait(ctx, "a"); err == nil {
		t.Error("a wait past the deadline succeeded")
	}
	if d := time.Since(start); d > 100*time.Millisecond {
		t.Errorf("a wait that cannot make the deadline took %v to say so", d)
	}
}

func TestWhatsAppReadLimit(t *testing.T) {
	for _, c := range []struct {
		perSec int
		want   int
	}{{40, 400}, {5, 100}, {80, 500}} {
		if got := whatsappReadLimit(c.perSec, whatsappFlushBudget, whatsappSendTimeout); got != c.want {
			t.Errorf("read limit at %d/s = %d, want %d", c.perSec, got, c.want)
		}
	}
}
