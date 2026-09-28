package notify

import (
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
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

	/* Sequence is the event's revision (RFC 5545 §3.8.7.4). A calendar that already holds
	 * this UID replaces its copy only when the new file's SEQUENCE is higher, so every file
	 * that changes the event must carry a larger number than the last one sent. Zero is
	 * the first version and is still written out, so a client never has to guess. */
	Sequence int
	/* Cancelled makes the file a METHOD:CANCEL / STATUS:CANCELLED for the same UID, which
	 * removes the event from a calendar that imported the earlier file. */
	Cancelled bool

	// Organizer is written as ORGANIZER only when it has an address.
	OrganizerName  string
	OrganizerEmail string
	// Attendee is written as ATTENDEE only when it has an address.
	AttendeeName  string
	AttendeeEmail string
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

// icsParam quotes a parameter value such as CN. DQUOTE cannot appear inside one at all
// (RFC 5545 §3.1), and CR/LF would end the line.
func icsParam(value string) string {
	value = strings.NewReplacer(`"`, "'", "\r", " ", "\n", " ").Replace(strings.TrimSpace(value))
	return `"` + value + `"`
}

func icsAddress(prop, name, email string) string {
	email = strings.TrimSpace(email)
	if email == "" || strings.ContainsAny(email, "\r\n:;, ") {
		return ""
	}
	line := prop
	if n := strings.TrimSpace(name); n != "" {
		line += ";CN=" + icsParam(n)
	}
	return line + ":mailto:" + email
}

/* foldLine splits a content line at 75 octets (RFC 5545 §3.1): each continuation starts
 * with a single space, which the reader removes. Octets, not characters, and never inside
 * a UTF-8 sequence — a topic in Devanagari is three bytes a letter, and cutting one in
 * half is a broken file for strict parsers. */
func foldLine(line string) string {
	const limit = 75
	if len(line) <= limit {
		return line
	}
	var b strings.Builder
	width := limit
	for len(line) > width {
		cut := width
		for cut > 0 && !utf8.RuneStart(line[cut]) {
			cut--
		}
		b.WriteString(line[:cut])
		b.WriteString("\r\n ")
		line = line[cut:]
		width = limit - 1 // the leading space counts
	}
	b.WriteString(line)
	return b.String()
}

// ICSMethod is the METHOD of a calendar file ICSFile produced, for the MIME header that
// must agree with it. PUBLISH when there is none.
func ICSMethod(ics string) string {
	for _, line := range strings.Split(ics, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), "METHOD:"); ok {
			return strings.TrimSpace(v)
		}
	}
	return "PUBLISH"
}

// ICSFile is an RFC 5545 VCALENDAR. CRLF line endings: Outlook rejects bare newlines.
func ICSFile(event CalendarEvent) string {
	if event.DurationMin <= 0 {
		event.DurationMin = 60
	}
	if event.Sequence < 0 {
		event.Sequence = 0
	}
	end := event.StartsAt.Add(time.Duration(event.DurationMin) * time.Minute)
	desc := strings.TrimSpace(event.Description + "\n\n" + event.URL)
	method := "PUBLISH"
	if event.Cancelled {
		method = "CANCEL"
	}
	lines := []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Webinar Liv//Webinar//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:" + method,
		"BEGIN:VEVENT",
		"UID:" + icsEscape(event.UID),
		"SEQUENCE:" + strconv.Itoa(event.Sequence),
		"DTSTAMP:" + stamp(time.Now()),
		"DTSTART:" + stamp(event.StartsAt),
		"DTEND:" + stamp(end),
		"SUMMARY:" + icsEscape(event.Title),
	}
	if org := icsAddress("ORGANIZER", event.OrganizerName, event.OrganizerEmail); org != "" {
		lines = append(lines, org)
	}
	if att := icsAddress("ATTENDEE", event.AttendeeName, event.AttendeeEmail); att != "" {
		lines = append(lines, att)
	}
	if event.Cancelled {
		// No link and no alarm: there is nothing left to join or be reminded of.
		lines = append(lines, "STATUS:CANCELLED")
		if d := strings.TrimSpace(event.Description); d != "" {
			lines = append(lines, "DESCRIPTION:"+icsEscape(d))
		}
	} else {
		lines = append(lines,
			"STATUS:CONFIRMED",
			"DESCRIPTION:"+icsEscape(desc),
			"URL:"+icsEscape(event.URL),
			"LOCATION:"+icsEscape(event.URL),
			"BEGIN:VALARM",
			"TRIGGER:-PT15M",
			"ACTION:DISPLAY",
			"DESCRIPTION:"+icsEscape(event.Title)+" starts in 15 minutes",
			"END:VALARM",
		)
	}
	lines = append(lines, "END:VEVENT", "END:VCALENDAR")
	for i, l := range lines {
		lines[i] = foldLine(l)
	}
	return strings.Join(lines, "\r\n")
}
