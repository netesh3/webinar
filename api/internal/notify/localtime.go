package notify

import (
	"fmt"
	"time"
)

/* DefaultTimeZone is the display zone a webinar gets when nobody chose one.
 *
 * A default rather than a policy: a host in another zone picks their own on the form and it
 * is stored per webinar. Here, not in either module, because an email and a WhatsApp
 * reminder about the same webinar must name the same time. */
const DefaultTimeZone = "Asia/Kolkata"

/* LocalTime renders an instant the way the webinar's audience reads a clock, with the zone
 * abbreviation (IST, EDT) so a reader in another zone can tell. An empty or unknown zone
 * falls back to DefaultTimeZone; with no tzdata at all, UTC beats no answer. */
func LocalTime(at time.Time, zone string) string {
	if zone == "" {
		zone = DefaultTimeZone
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		if loc, err = time.LoadLocation(DefaultTimeZone); err != nil {
			return at.UTC().Format("15:04 on 2 January 2006") + " UTC"
		}
	}
	return at.In(loc).Format("15:04 on 2 January 2006 MST")
}

// WhenText is LocalTime for an RFC 3339 string, or "" when it does not parse.
func WhenText(startsAt, zone string) string {
	at, err := time.Parse(time.RFC3339, startsAt)
	if err != nil {
		return ""
	}
	return LocalTime(at, zone)
}

/* StartsIn says how long before the start a reminder is, the way the reminder says it:
 * "in 24 hours", "in 1 hour 30 minutes", "in 2 days", "in 1 minute".
 *
 * Whole days up to a week read as days only when they are whole ("in 2 days", but
 * "in 36 hours" rather than "in 1 day 12 hours"). Used by the email subject and the
 * WhatsApp `starts_in` merge field, so both channels say the same thing.
 */
func StartsIn(minutes int) string {
	if minutes < 1 {
		return "now"
	}
	unit := func(n int, one string) string {
		if n == 1 {
			return "1 " + one
		}
		return fmt.Sprintf("%d %ss", n, one)
	}
	const day = 24 * 60
	if minutes >= 2*day && minutes%day == 0 {
		return "in " + unit(minutes/day, "day")
	}
	h, m := minutes/60, minutes%60
	switch {
	case h == 0:
		return "in " + unit(m, "minute")
	case m == 0:
		return "in " + unit(h, "hour")
	default:
		return "in " + unit(h, "hour") + " " + unit(m, "minute")
	}
}
