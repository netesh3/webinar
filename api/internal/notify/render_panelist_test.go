package notify

import (
	"strings"
	"testing"
)

func panelistSample() Invite {
	return Invite{
		Name: "Pam Panel", Topic: `Say "hi" \ launch`, WhenText: "Tue 10:00", HostName: "Ganesh",
		StageURL: "https://example/host/launch/room", JoinURL: "https://example/room?k=SECRET",
		Email: "pam@example.com", Product: "Webinar Liv", Calendar: true,
		WasText: "Mon 9:00",
	}
}

func TestPanelistMailCarriesOnlyTheStageLink(t *testing.T) {
	in := panelistSample()
	_, invited, invitedHTML := PanelistInvited(in)
	_, moved, movedHTML := PanelistRescheduled(in)
	for _, body := range []string{invited, moved, invitedHTML, movedHTML} {
		if !strings.Contains(body, in.StageURL) {
			t.Errorf("expected the stage link in %q", body)
		}
		if strings.Contains(body, "SECRET") {
			t.Errorf("a panelist mail carries an attendee join key: %q", body)
		}
	}
	if !strings.Contains(moved, "New time: Tue 10:00") || !strings.Contains(moved, "Was: Mon 9:00") {
		t.Errorf("reschedule does not say the new and old time: %q", moved)
	}
	_, cancelled, cancelledHTML := PanelistCancelled(in)
	for _, body := range []string{cancelled, cancelledHTML} {
		if strings.Contains(body, in.StageURL) || strings.Contains(body, "SECRET") {
			t.Errorf("a cancellation carries a link: %q", body)
		}
	}
}

func TestPanelistMailWording(t *testing.T) {
	in := panelistSample()
	subject, invited, html := PanelistInvited(in)
	if subject != `You're a panelist: Say "hi" \ launch` {
		t.Errorf("subject = %q", subject)
	}
	for _, want := range []string{
		"Hi Pam,\n\n",
		`Ganesh has added you as a panelist for “Say "hi" \ launch”.`,
		"When: Tue 10:00",
		"Sign in with pam@example.com",
		"The attached calendar file adds the session to your calendar.",
		"Thanks,\nGanesh\n",
	} {
		if !strings.Contains(invited, want) {
			t.Errorf("invite text is missing %q:\n%s", want, invited)
		}
	}
	for _, bad := range []string{`\"`, "panelist on", "so you can add this to your calendar"} {
		if strings.Contains(invited, bad) {
			t.Errorf("invite text still says %q:\n%s", bad, invited)
		}
	}
	if !strings.Contains(html, ">Join the stage</a>") || !strings.Contains(html, "Hi Pam,") {
		t.Errorf("invite HTML has no Join the stage button or greeting")
	}

	_, moved, _ := PanelistRescheduled(in)
	if strings.Contains(moved, "where you're a panelist, has a new time") {
		t.Errorf("reschedule uses the old wording:\n%s", moved)
	}

	_, cancelled, _ := PanelistCancelled(in)
	if !strings.Contains(cancelled, "has been cancelled.\n\nYou don't need to do anything.") {
		t.Errorf("cancellation sentences are not separated by a blank line:\n%s", cancelled)
	}
	if !strings.Contains(cancelled, "removes the event from your calendar") {
		t.Errorf("cancellation does not mention the calendar file:\n%s", cancelled)
	}
}

func TestPanelistMailFallbacks(t *testing.T) {
	in := Invite{Topic: "Launch", StageURL: "https://example/host/launch/room", Product: "Webinar Liv"}
	for name, render := range map[string]func(Invite) (string, string, string){
		"invited": PanelistInvited, "rescheduled": PanelistRescheduled, "cancelled": PanelistCancelled,
	} {
		_, text, html := render(in)
		if !strings.HasPrefix(text, "Hi there,\n") {
			t.Errorf("%s: no-name greeting = %q", name, strings.SplitN(text, "\n", 2)[0])
		}
		if !strings.Contains(text, "Thanks,\nThe Webinar Liv team\n") || !strings.Contains(html, "The Webinar Liv team") {
			t.Errorf("%s: no fallback sign-off without a host name:\n%s", name, text)
		}
		if strings.Contains(text, "calendar file") {
			t.Errorf("%s: promises a calendar file that is not attached:\n%s", name, text)
		}
	}
	_, text, _ := PanelistInvited(in)
	if !strings.Contains(text, "You've been added as a panelist for “Launch”.") {
		t.Errorf("hostless invite wording:\n%s", text)
	}
}

func TestPanelistHTMLEscapesUserText(t *testing.T) {
	in := panelistSample()
	in.Topic = "<script>alert(1)</script>"
	in.HostName = "<b>Host</b>"
	_, _, html := PanelistInvited(in)
	for _, bad := range []string{"<script>alert", "<b>Host</b>"} {
		if strings.Contains(html, bad) {
			t.Errorf("unescaped user input %q in HTML", bad)
		}
	}
}

func TestApprovalMailQuotesTopicsTypographically(t *testing.T) {
	in := Invite{Name: "Asha", Topic: `The "big" one`, JoinURL: "https://example/room?k=K"}
	subject, body := ApprovalRequested(in, 1)
	_, approved := RegistrationApproved(in)
	_, declined := RegistrationDeclined(in)
	_, confirmed := RegistrationConfirmed(in)
	for _, s := range []string{subject, body, approved, declined, confirmed} {
		if strings.Contains(s, `\"`) || !strings.Contains(s, `“The "big" one”`) {
			t.Errorf("topic not quoted plainly: %q", s)
		}
	}
}
