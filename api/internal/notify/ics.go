package notify

import (
	"strings"
	"time"
)

// CalendarEvent is the webinar as a calendar attachment. UID should be stable
// per registration so a later reminder updates the same event rather than
// creating a duplicate.
type CalendarEvent struct {
	UID         string
	Title       string
	Description string
	URL         string
	StartsAt    time.Time
	DurationMin int
}

func stamp(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

func icsEscape(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `;`, `\;`)
	value = strings.ReplaceAll(value, `,`, `\,`)
	value = strings.ReplaceAll(value, "\r\n", `\n`)
	value = strings.ReplaceAll(value, "\n", `\n`)
	return value
}

// ICSFile is an RFC 5545 VCALENDAR. CRLF line endings: Outlook rejects bare newlines.
func ICSFile(event CalendarEvent) string {
	if event.DurationMin <= 0 {
		event.DurationMin = 60
	}
	end := event.StartsAt.Add(time.Duration(event.DurationMin) * time.Minute)
	desc := strings.TrimSpace(event.Description + "\n\n" + event.URL)
	lines := []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Webinar Liv//Webinar//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"BEGIN:VEVENT",
		"UID:" + icsEscape(event.UID),
		"DTSTAMP:" + stamp(time.Now()),
		"DTSTART:" + stamp(event.StartsAt),
		"DTEND:" + stamp(end),
		"SUMMARY:" + icsEscape(event.Title),
		"DESCRIPTION:" + icsEscape(desc),
		"URL:" + icsEscape(event.URL),
		"LOCATION:" + icsEscape(event.URL),
		"BEGIN:VALARM",
		"TRIGGER:-PT15M",
		"ACTION:DISPLAY",
		"DESCRIPTION:" + icsEscape(event.Title) + " starts in 15 minutes",
		"END:VALARM",
		"END:VEVENT",
		"END:VCALENDAR",
	}
	return strings.Join(lines, "\r\n")
}
