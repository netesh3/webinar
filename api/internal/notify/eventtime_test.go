package notify

import (
	"testing"
	"time"
)

func TestEventTime(t *testing.T) {
	at := time.Date(2026, 9, 28, 16, 30, 0, 0, time.UTC) // 22:00 in Kolkata
	cases := []struct {
		dur  int
		zone string
		want string
	}{
		{60, "Asia/Kolkata", "Mon 28 Sep 2026, 10:00 PM – 11:00 PM GMT+5:30 (1 hour)"},
		{90, "", "Mon 28 Sep 2026, 10:00 PM – 11:30 PM GMT+5:30 (1 hour 30 minutes)"},
		{45, "UTC", "Mon 28 Sep 2026, 4:30 PM – 5:15 PM GMT (45 minutes)"},
		{120, "Asia/Kolkata", "Mon 28 Sep 2026, 10:00 PM – Tue 29 Sep, 12:00 AM GMT+5:30 (2 hours)"},
		{60, "America/New_York", "Mon 28 Sep 2026, 12:30 PM – 1:30 PM GMT-4 (1 hour)"},
		{60, "Not/AZone", "Mon 28 Sep 2026, 10:00 PM – 11:00 PM GMT+5:30 (1 hour)"},
	}
	for _, c := range cases {
		if got := EventTime(at, c.dur, c.zone); got != c.want {
			t.Errorf("EventTime(%d, %q) = %q, want %q", c.dur, c.zone, got, c.want)
		}
	}
	if got := EventStart(at, "Asia/Kolkata"); got != "Mon 28 Sep 2026, 10:00 PM GMT+5:30" {
		t.Errorf("EventStart = %q", got)
	}
}
