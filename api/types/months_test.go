package types

import (
	"testing"
	"time"
)

func TestAddMonthsClampsToTheMonthEnd(t *testing.T) {
	day := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 14, 30, 5, 0, time.UTC) }
	ist := time.FixedZone("IST", 5*3600+1800)
	cases := []struct {
		from time.Time
		n    int
		want time.Time
	}{
		{day(2026, time.January, 31), 1, day(2026, time.February, 28)},
		{day(2028, time.January, 31), 1, day(2028, time.February, 29)},
		{day(2026, time.January, 31), 3, day(2026, time.April, 30)},
		{day(2026, time.October, 29), 3, day(2027, time.January, 29)},
		{day(2026, time.October, 30), 3, day(2027, time.January, 30)},
		{day(2026, time.October, 31), 1, day(2026, time.November, 30)},
		{day(2026, time.October, 31), 3, day(2027, time.January, 31)},
		{day(2026, time.October, 29), 4, day(2027, time.February, 28)},
		{day(2026, time.October, 30), 4, day(2027, time.February, 28)},
		{day(2026, time.October, 31), 4, day(2027, time.February, 28)},
		{day(2026, time.November, 30), 3, day(2027, time.February, 28)},
		{day(2026, time.December, 31), 2, day(2027, time.February, 28)},
		{day(2026, time.December, 31), 3, day(2027, time.March, 31)},
		{day(2026, time.December, 31), 12, day(2027, time.December, 31)},
		{day(2028, time.February, 29), 3, day(2028, time.May, 29)},
		{day(2028, time.February, 29), 12, day(2029, time.February, 28)},
		{day(2028, time.February, 29), 48, day(2032, time.February, 29)},
		{day(2026, time.March, 31), -1, day(2026, time.February, 28)},
		{day(2026, time.May, 15), 0, day(2026, time.May, 15)},
		// Another zone's instant moves by its UTC date: 1 Nov 02:00 IST is 31 Oct 20:30 UTC.
		{time.Date(2026, time.November, 1, 2, 0, 0, 0, ist), 3, time.Date(2027, time.January, 31, 20, 30, 0, 0, time.UTC)},
	}
	for _, c := range cases {
		if got := AddMonths(c.from, c.n); !got.Equal(c.want) || got.Location() != time.UTC {
			t.Errorf("AddMonths(%s, %d) = %s, want %s", c.from.Format(time.RFC3339), c.n, got, c.want)
		}
	}
}
