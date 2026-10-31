package types

import "time"

/* AddMonths is t moved n calendar months, in UTC, with the day clamped to the last day of
 * the target month: 31 Jan + 1 month is 28 (or 29) Feb, not time.AddDate's 2 (or 3) Mar.
 * The time of day is kept. "Keep longer" sets the new expiry with it, so a recording kept
 * on a month end goes on the target month's end rather than spilling into the next one, and
 * the tests compute the expiry they expect with it too. */
func AddMonths(t time.Time, n int) time.Time {
	u := t.UTC()
	y, m, d := u.Date()
	first := time.Date(y, m+time.Month(n), 1, 0, 0, 0, 0, time.UTC)
	if last := first.AddDate(0, 1, -1).Day(); d > last {
		d = last
	}
	return time.Date(first.Year(), first.Month(), d, u.Hour(), u.Minute(), u.Second(), u.Nanosecond(), time.UTC)
}
