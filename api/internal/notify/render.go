package notify

import (
	"fmt"
	"strings"
)

/* What each notification says.
 *
 * Pure functions, no store and no transport, because the wording is the part most likely to be
 * wrong and the part hardest to check any other way. A test can assert that an approval email
 * contains the join link and nothing else does — which is the one mistake in this file that
 * would actually matter, since the link is a bearer credential.
 */

// Invite carries everything a rendered message needs. Assembled by the caller so these
// functions never touch the database.
type Invite struct {
	Name     string // the registrant's display name, may be empty
	Topic    string
	WhenText string // already formatted in the webinar's own zone by the caller
	JoinURL  string // personal: contains the access token
	HostName string
	/* ReplayURL is the recording's public page, and is the opposite of JoinURL: the
	 * same link for everybody, carrying no token, safe to forward. Kept as a separate
	 * field rather than reusing JoinURL so no renderer can reach for the personal one
	 * when it meant the public one. */
	ReplayURL string
	/* Passcode is the recording's, when it has one. Included in the replay mail on
	 * purpose: the passcode keeps strangers off a public URL, and the people this
	 * message goes to are the ones the host already approved — sending them a link they
	 * cannot open would be a notification about a door that is locked. */
	Passcode string
}

// greeting avoids "Hi ," for a registrant who gave no name.
func greeting(name string) string {
	if n := strings.TrimSpace(name); n != "" {
		return "Hi " + n + ","
	}
	return "Hi,"
}

/* ApprovalRequested is the HOST's alert. No join link in it, and that is not an omission.
 *
 * The host has their own way in, and the registrant's link is a bearer credential — putting it
 * in a message to a third party would mean two people holding one person's access, which is
 * both a privacy problem and a way for the same key to be used twice.
 */
func ApprovalRequested(in Invite, waiting int) (subject, body string) {
	subject = fmt.Sprintf("Someone is waiting to join %q", in.Topic)
	if waiting > 1 {
		subject = fmt.Sprintf("%d people are waiting to join %q", waiting, in.Topic)
	}

	who := strings.TrimSpace(in.Name)
	if who == "" {
		who = "Someone"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s registered for %q and needs your approval before they can join.\n\n",
		who, in.Topic)
	if in.WhenText != "" {
		fmt.Fprintf(&b, "The session starts %s.\n\n", in.WhenText)
	}
	if waiting > 1 {
		fmt.Fprintf(&b, "There are %d registrations waiting in total.\n\n", waiting)
	}
	b.WriteString("Approve or decline them from the webinar's Registrants tab.\n")
	return subject, b.String()
}

/* RegistrationApproved is the invitation, and the only message that carries the join link. */
func RegistrationApproved(in Invite) (subject, body string) {
	subject = fmt.Sprintf("You're in: %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	fmt.Fprintf(&b, "Your registration for %q has been approved.\n\n", in.Topic)
	if in.WhenText != "" {
		fmt.Fprintf(&b, "When: %s\n\n", in.WhenText)
	}
	b.WriteString("Your personal join link:\n")
	b.WriteString(in.JoinURL + "\n\n")
	/* Said explicitly because it is true and because people share these.
	 *
	 * The link contains the access token, so forwarding it hands over the seat. Attendees do
	 * forward them, and a line of copy is the only control available at this layer — the
	 * server cannot tell a forwarded link from the original. */
	b.WriteString("This link is yours alone — anyone who has it can take your place, so please don't forward it.\n")
	if h := strings.TrimSpace(in.HostName); h != "" {
		fmt.Fprintf(&b, "\nSee you there,\n%s\n", h)
	}
	return subject, b.String()
}

/* RegistrationDeclined exists because silence is worse.
 *
 * A registrant who is declined and told nothing turns up expecting to be let in, and the first
 * they learn of it is a door that will not open — usually a minute before the session starts,
 * which is when the host is least able to deal with it.
 *
 * No reason is given. The host did not supply one, and inventing "the session is full" when it
 * might have been anything is worse than being brief.
 */
func RegistrationDeclined(in Invite) (subject, body string) {
	subject = fmt.Sprintf("About your registration for %s", in.Topic)

	var b strings.Builder
	b.WriteString(greeting(in.Name) + "\n\n")
	fmt.Fprintf(&b, "Your registration for %q wasn't approved, so you won't be able to join this session.\n\n",
		in.Topic)
	b.WriteString("If you think that's a mistake, reply to this message and the host can take another look.\n")
	return subject, b.String()
}
