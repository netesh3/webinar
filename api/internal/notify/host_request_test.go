package notify

import (
	"strings"
	"testing"
	"time"
)

func TestHostRequestEmailCarriesTheAccount(t *testing.T) {
	subject, body := HostRequestEmail(HostRequestNotice{
		Name:   "Ada Lovelace",
		Email:  "ada@example.com",
		Phone:  "+919876543210",
		UserID: "user-123",
	})
	for _, part := range []string{subject, body} {
		for _, want := range []string{
			"Ada Lovelace",
			"ada@example.com",
			"+919876543210",
			"user-123",
			"requested hosting",
		} {
			if !strings.Contains(part, want) {
				t.Errorf("missing %q in:\n%s", want, part)
			}
		}
	}
	if strings.Contains(subject, "\n") {
		t.Errorf("subject is not one line: %q", subject)
	}
}

func TestHostRequestComposeKeepsConfiguredFrom(t *testing.T) {
	s := SMTP{
		Host: "smtp.gmail.com",
		Port: 587,
		From: "Webinar Liv <webinarliv@gmail.com>",
	}
	raw := s.compose(Message{
		To:      HostRequestRecipient,
		Subject: "Ada requested hosting",
		Body:    "Ada requested hosting.",
		ReplyTo: "ada@example.com",
	}, time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC))

	if !strings.Contains(raw, "To: "+HostRequestRecipient) {
		t.Errorf("To header:\n%s", raw)
	}
	if !strings.Contains(raw, "Reply-To: <ada@example.com>") {
		t.Errorf("Reply-To header:\n%s", raw)
	}
	if !strings.Contains(raw, "From: \"Webinar Liv\" <webinarliv@gmail.com>") &&
		!strings.Contains(raw, "From: Webinar Liv <webinarliv@gmail.com>") {
		t.Errorf("From is not the configured sender:\n%s", raw)
	}
	if strings.Contains(raw, "From: ada@example.com") {
		t.Errorf("From was replaced with the requester:\n%s", raw)
	}
}
