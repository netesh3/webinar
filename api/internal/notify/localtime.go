package notify

import "time"

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
