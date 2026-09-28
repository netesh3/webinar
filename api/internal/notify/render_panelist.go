package notify

import (
	"fmt"
	"strings"
)

/* What a panelist is told. Their link is StageURL, never JoinURL: a panelist reaches the
 * stage by signing in, and an attendee join link would seat them in the audience. */

// PanelistInvited is sent when somebody is added to a scheduled webinar's panel.
func PanelistInvited(in Invite) (subject, body string) {
	subject = fmt.Sprintf("You're a panelist: %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "%s has added you as a panelist on %q.\n\n", h, in.Topic)
	} else {
		fmt.Fprintf(&b, "You've been added as a panelist on %q.\n\n", in.Topic)
	}
	if in.WhenText != "" {
		fmt.Fprintf(&b, "When: %s\n\n", in.WhenText)
	}
	b.WriteString("Join the stage here:\n")
	b.WriteString(in.StageURL + "\n\n")
	b.WriteString("Sign in with this email address and you'll go straight onto the stage, where you can share your camera and screen.\n")
	b.WriteString("A calendar file is attached so you can add this to your calendar.\n")
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "\nSee you there,\n%s\n", h)
	}
	return subject, b.String()
}

// PanelistRescheduled tells an already-invited panelist the start moved.
func PanelistRescheduled(in Invite) (subject, body string) {
	subject = fmt.Sprintf("New time: %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	fmt.Fprintf(&b, "%q, where you're a panelist, has a new time.\n\n", in.Topic)
	if in.WhenText != "" {
		fmt.Fprintf(&b, "New time: %s\n\n", in.WhenText)
	}
	b.WriteString("Your stage link hasn't changed:\n")
	b.WriteString(in.StageURL + "\n\n")
	b.WriteString("An updated calendar file is attached.\n")
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "\n%s\n", h)
	}
	return subject, b.String()
}

// PanelistCancelled tells an invited panelist the webinar was deleted before it ran. No
// link: there is no longer anything to join.
func PanelistCancelled(in Invite) (subject, body string) {
	subject = fmt.Sprintf("Cancelled: %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	if in.WhenText != "" {
		fmt.Fprintf(&b, "%q, scheduled for %s, has been cancelled.\n", in.Topic, in.WhenText)
	} else {
		fmt.Fprintf(&b, "%q has been cancelled.\n", in.Topic)
	}
	b.WriteString("You don't need to do anything; you can remove it from your calendar.\n")
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "\n%s\n", h)
	}
	return subject, b.String()
}
