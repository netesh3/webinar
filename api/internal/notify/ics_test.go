package notify

import (
	"strings"
	"testing"
	"time"
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
}
