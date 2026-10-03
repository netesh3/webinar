package notify

import (
	"strings"
	"testing"
)

func TestPasswordResetMailCarriesTheLinkAndItsLimits(t *testing.T) {
	link := "https://app.example.com/reset-password?token=abc123"
	subject, body := PasswordReset("Webinar Liv", "Priya Sharma", link)

	if subject != "Reset your Webinar Liv password" {
		t.Errorf("subject = %q", subject)
	}
	for _, want := range []string{
		"Hi Priya Sharma,",
		link,
		// The mail must say what the server enforces (store.PasswordResetTTL), and
		// what to do for somebody who did not ask.
		"works once and expires in 1 hour",
		"If you did not ask, you can ignore this email",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body is missing %q:\n%s", want, body)
		}
	}

	if subject, _ := PasswordReset("", "", link); subject != "Reset your password" {
		t.Errorf("subject with no product = %q", subject)
	}
	if _, body := PasswordReset("", "", link); !strings.HasPrefix(body, "Hi,") {
		t.Errorf("body with no name starts %q", body[:10])
	}
}
