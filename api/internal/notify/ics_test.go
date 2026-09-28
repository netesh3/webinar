package notify

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestICSFileContainsJoinURLAndCRLF(t *testing.T) {
	raw := ICSFile(CalendarEvent{
		UID:         "reg-1@webinarliv.com",
		Title:       "Launch, with friends",
		Description: "Line one\nLine two",
		URL:         "https://webinarliv.com/webinars/abc/room?k=KEY",
		StartsAt:    time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC),
		DurationMin: 45,
	})
	if !strings.Contains(raw, "\r\n") {
		t.Fatal("ics must use CRLF")
	}
	if !strings.Contains(raw, "https://webinarliv.com/webinars/abc/room?k=KEY") {
		t.Fatal("join URL missing")
	}
	if !strings.Contains(raw, "Launch\\, with friends") {
		t.Fatalf("comma in summary should be escaped: %s", raw)
	}
	if !strings.Contains(raw, "DTEND:20260920T104500Z") {
		t.Fatalf("duration not applied: %s", raw)
	}
	if !strings.Contains(raw, "METHOD:PUBLISH\r\n") || !strings.Contains(raw, "SEQUENCE:0\r\n") {
		t.Fatalf("attendee file should stay PUBLISH, sequence 0: %s", raw)
	}
	if strings.Contains(raw, "ORGANIZER") || strings.Contains(raw, "ATTENDEE") {
		t.Fatalf("attendee file gained addresses it was not given: %s", raw)
	}
}

// unfold reverses RFC 5545 folding.
func unfold(raw string) string { return strings.ReplaceAll(raw, "\r\n ", "") }

func TestICSFileFoldsLongLinesAt75Octets(t *testing.T) {
	title := strings.Repeat("Scaling Postgres ", 6) + "— प्रिया की कार्यशाला"
	raw := ICSFile(CalendarEvent{
		UID: "x@webinarliv.com", Title: title, Description: strings.Repeat("long text ", 30),
		URL:      "https://webinarliv.com/host/" + strings.Repeat("a", 90) + "/room",
		StartsAt: time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC),
	})
	for _, line := range strings.Split(raw, "\r\n") {
		if len(line) > 75 {
			t.Errorf("line of %d octets: %q", len(line), line)
		}
		if !utf8.ValidString(line) {
			t.Errorf("fold split a UTF-8 sequence: %q", line)
		}
	}
	if !strings.Contains(unfold(raw), "SUMMARY:"+icsEscape(title)+"\r\n") {
		t.Errorf("summary does not survive unfolding:\n%s", raw)
	}
	if strings.Contains(raw, "\r\r\n") {
		t.Errorf("doubled CR")
	}
}

func TestICSFileSequenceOrganizerAndCancel(t *testing.T) {
	ev := CalendarEvent{
		UID: "panelist-u-s@webinarliv.com", Title: "Launch", URL: "https://example/host/s/room",
		StartsAt: time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC), DurationMin: 60, Sequence: 42,
		OrganizerName: `Ganesh "G" K`, OrganizerEmail: "host@example.com",
		AttendeeName: "Pam", AttendeeEmail: "pam@example.com",
	}
	raw := unfold(ICSFile(ev))
	for _, want := range []string{
		"METHOD:PUBLISH\r\n", "SEQUENCE:42\r\n", "UID:panelist-u-s@webinarliv.com\r\n",
		`ORGANIZER;CN="Ganesh 'G' K":mailto:host@example.com` + "\r\n",
		`ATTENDEE;CN="Pam":mailto:pam@example.com` + "\r\n", "STATUS:CONFIRMED\r\n", "BEGIN:VALARM",
	} {
		if !strings.Contains(raw, want) {
			t.Errorf("missing %q in:\n%s", want, raw)
		}
	}
	if ICSMethod(raw) != "PUBLISH" {
		t.Errorf("ICSMethod = %q", ICSMethod(raw))
	}

	ev.Cancelled, ev.Sequence = true, 43
	cancel := unfold(ICSFile(ev))
	for _, want := range []string{
		"METHOD:CANCEL\r\n", "STATUS:CANCELLED\r\n", "SEQUENCE:43\r\n", "UID:panelist-u-s@webinarliv.com\r\n",
	} {
		if !strings.Contains(cancel, want) {
			t.Errorf("cancel missing %q in:\n%s", want, cancel)
		}
	}
	if strings.Contains(cancel, "VALARM") || strings.Contains(cancel, "/room") {
		t.Errorf("cancel keeps an alarm or a link:\n%s", cancel)
	}
	if ICSMethod(cancel) != "CANCEL" {
		t.Errorf("ICSMethod = %q", ICSMethod(cancel))
	}

	ev.OrganizerEmail = "bad address\r\nX-INJECT:1"
	if strings.Contains(ICSFile(ev), "X-INJECT") {
		t.Error("an address with CRLF reached the file")
	}
}

func TestComposeUsesTheCalendarMethod(t *testing.T) {
	s := SMTP{Host: "smtp.example.test", From: "hello@example.test"}
	ics := ICSFile(CalendarEvent{UID: "u", Title: "T", StartsAt: time.Unix(0, 0), Cancelled: true})
	msg := s.compose(Message{To: "a@example.test", Subject: "Cancelled: T", Body: "x", ICS: ics, ICSName: "webinar.ics"}, time.Unix(0, 0))
	if !strings.Contains(msg, "text/calendar; charset=utf-8; method=CANCEL;") {
		t.Errorf("MIME method does not match the file:\n%s", msg)
	}
	if strings.Contains(msg, "\r\r\n") {
		t.Errorf("calendar part has doubled CRs")
	}
}
