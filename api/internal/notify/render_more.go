package notify

import (
	"fmt"
	"strings"
)

// RegistrationConfirmed is the auto-approve path: they are in, no host reviewed them.
func RegistrationConfirmed(in Invite) (subject, body string) {
	subject = fmt.Sprintf("You're registered: %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	fmt.Fprintf(&b, "You're registered for %q.\n\n", in.Topic)
	if in.WhenText != "" {
		fmt.Fprintf(&b, "When: %s\n\n", in.WhenText)
	}
	b.WriteString("Your personal join link:\n")
	b.WriteString(in.JoinURL + "\n\n")
	b.WriteString("A calendar file is attached so you can add this to your calendar.\n")
	b.WriteString("This link is yours alone — anyone who has it can take your place, so please don't forward it.\n")
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "\nSee you there,\n%s\n", h)
	}
	return subject, b.String()
}

/* ReplayReady tells a registrant the recording is up.
 *
 * Sent to everybody who was approved, whether or not they turned up — the people who
 * missed it are most of the reason this message exists, and "sorry you couldn't make
 * it" is the wrong guess to make about somebody who was in the room.
 *
 * ReplayURL, never JoinURL. The recording's page is public and shareable; the join
 * link is that person's seat, and a session that has finished is exactly when a stale
 * one would be forwarded around.
 */
func ReplayReady(in Invite) (subject, body string) {
	subject = fmt.Sprintf("The recording is ready: %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	fmt.Fprintf(&b, "The recording of %q is now available to watch.\n\n", in.Topic)
	b.WriteString("Watch it here:\n")
	b.WriteString(in.ReplayURL + "\n\n")
	if p := strings.TrimSpace(in.Passcode); p != "" {
		fmt.Fprintf(&b, "Passcode: %s\n\n", p)
	}
	// No "don't forward this" line, and its absence is the point: this one may be
	// shared, and saying otherwise would train people to ignore the warning on the
	// message where it is true.
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "Thanks for joining,\n%s\n", h)
	}
	return subject, b.String()
}

// Reminder is the 24h or 1h ping. Same join link as confirmation.
func Reminder(in Invite, window string) (subject, body string) {
	subject = fmt.Sprintf("Starting %s: %s", window, in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	fmt.Fprintf(&b, "%q starts %s.\n\n", in.Topic, window)
	if in.WhenText != "" {
		fmt.Fprintf(&b, "When: %s\n\n", in.WhenText)
	}
	b.WriteString("Your personal join link:\n")
	b.WriteString(in.JoinURL + "\n\n")
	b.WriteString("This link is yours alone — anyone who has it can take your place, so please don't forward it.\n")
	return subject, b.String()
}
