package notify

import "testing"

func TestStartsIn(t *testing.T) {
	for minutes, want := range map[int]string{
		1:     "in 1 minute",
		5:     "in 5 minutes",
		60:    "in 1 hour",
		90:    "in 1 hour 30 minutes",
		180:   "in 3 hours",
		1440:  "in 24 hours",
		2160:  "in 36 hours",
		2880:  "in 2 days",
		10080: "in 7 days",
	} {
		if got := StartsIn(minutes); got != want {
			t.Errorf("StartsIn(%d) = %q, want %q", minutes, got, want)
		}
	}
}
