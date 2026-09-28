package notify

import (
	"fmt"
	"strings"
	"time"
)

/* How a panelist's email names the session's time: the day, the start and end on the
 * webinar's own clock, the offset spelled as GMT±h:mm, and the length —
 * "Mon 28 Sep 2026, 10:00 PM – 11:00 PM GMT+5:30 (1 hour)".
 *
 * An offset rather than a zone abbreviation because abbreviations are ambiguous (IST is
 * India, Ireland and Israel) and many zones have none, which Go renders as "+0530". Kept
 * apart from LocalTime on purpose: that string also fills WhatsApp template fields and
 * the attendee reminders, and changing it would change messages this does not own. */

func eventLocation(zone string) *time.Location {
	if zone == "" {
		zone = DefaultTimeZone
	}
	if loc, err := time.LoadLocation(zone); err == nil {
		return loc
	}
	if loc, err := time.LoadLocation(DefaultTimeZone); err == nil {
		return loc
	}
	return time.UTC
}

// GMTOffset is "GMT+5:30", "GMT-4", or "GMT" for the offset in force at t.
func GMTOffset(t time.Time) string {
	_, secs := t.Zone()
	if secs == 0 {
		return "GMT"
	}
	sign := "+"
	if secs < 0 {
		sign, secs = "-", -secs
	}
	h, m := secs/3600, (secs%3600)/60
	if m == 0 {
		return fmt.Sprintf("GMT%s%d", sign, h)
	}
	return fmt.Sprintf("GMT%s%d:%02d", sign, h, m)
}

// DurationText is "45 minutes", "1 hour", "1 hour 30 minutes", "2 hours".
func DurationText(minutes int) string {
	if minutes <= 0 {
		return ""
	}
	unit := func(n int, one string) string {
		if n == 1 {
			return "1 " + one
		}
		return fmt.Sprintf("%d %ss", n, one)
	}
	h, m := minutes/60, minutes%60
	switch {
	case h == 0:
		return unit(m, "minute")
	case m == 0:
		return unit(h, "hour")
	default:
		return unit(h, "hour") + " " + unit(m, "minute")
	}
}

const (
	eventDay   = "Mon 2 Jan 2006"
	eventClock = "3:04 PM"
)

// EventStart is "Mon 28 Sep 2026, 10:00 PM GMT+5:30".
func EventStart(at time.Time, zone string) string {
	local := at.In(eventLocation(zone))
	return local.Format(eventDay) + ", " + local.Format(eventClock) + " " + GMTOffset(local)
}

/* EventTime is the start, the end and the length. An end on another calendar day names
 * that day too, so a late session never reads as ending before it began. */
func EventTime(at time.Time, durationMin int, zone string) string {
	if durationMin <= 0 {
		return EventStart(at, zone)
	}
	loc := eventLocation(zone)
	start := at.In(loc)
	end := at.Add(time.Duration(durationMin) * time.Minute).In(loc)
	endText := end.Format(eventClock)
	if end.YearDay() != start.YearDay() || end.Year() != start.Year() {
		endText = end.Format("Mon 2 Jan") + ", " + endText
	}
	return fmt.Sprintf("%s, %s – %s %s (%s)", start.Format(eventDay), start.Format(eventClock),
		endText, GMTOffset(end), DurationText(durationMin))
}

// quoted puts a topic in typographic quotes. %q is Go syntax: a topic with a quote or a
// backslash in it came out as `"Say \"hi\""`, which is not how anybody writes English.
func quoted(topic string) string {
	return "“" + strings.TrimSpace(topic) + "”"
}
