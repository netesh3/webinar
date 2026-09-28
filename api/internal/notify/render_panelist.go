package notify

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
)

/* What a panelist is told. Their link is StageURL, never JoinURL: a panelist reaches the
 * stage by signing in, and an attendee join link would seat them in the audience.
 *
 * Each message is plain text plus an HTML alternative built from the same pieces, so the
 * two parts cannot drift into saying different things. */

// panelistMail is one panelist message before it becomes text and HTML.
type panelistMail struct {
	Subject   string
	Preheader string
	Eyebrow   string
	Heading   string
	Greeting  string
	Lead      string
	When      string
	WhenLabel string
	Was       string
	LinkLabel string // the text version's line above the link
	Button    string
	URL       string
	Notes     []string
	SignOff   string
	Signer    string
	Product   string
	Cancelled bool
}

func panelistGreeting(name string) string {
	if first := FirstName(name); first != "" {
		return "Hi " + first + ","
	}
	return "Hi there,"
}

func productName(p string) string {
	if p = strings.TrimSpace(p); p != "" {
		return p
	}
	return "Webinar Liv"
}

// signer is the host, or the product's team when the webinar has no host name.
func signer(in Invite) string {
	if h := strings.TrimSpace(in.HostName); h != "" {
		return h
	}
	return "The " + productName(in.Product) + " team"
}

func signInNote(in Invite) string {
	if e := strings.TrimSpace(in.Email); e != "" {
		return "Sign in with " + e + " and you'll go straight onto the stage, where you can share your camera and screen."
	}
	return "Sign in with this email address and you'll go straight onto the stage, where you can share your camera and screen."
}

// PanelistInvited is sent when somebody is added to a scheduled webinar's panel.
func PanelistInvited(in Invite) (subject, text, html string) {
	lead := "You've been added as a panelist for " + quoted(in.Topic) + "."
	if h := strings.TrimSpace(in.HostName); h != "" {
		lead = h + " has added you as a panelist for " + quoted(in.Topic) + "."
	}
	m := panelistMail{
		Subject:   "You're a panelist: " + strings.TrimSpace(in.Topic),
		Preheader: lead,
		Eyebrow:   "You're a panelist",
		Heading:   strings.TrimSpace(in.Topic),
		Lead:      lead,
		When:      in.WhenText,
		WhenLabel: "When",
		LinkLabel: "Join the stage here:",
		Button:    "Join the stage",
		URL:       in.StageURL,
		Notes:     []string{signInNote(in)},
	}
	if in.Calendar {
		m.Notes = append(m.Notes, "The attached calendar file adds the session to your calendar.")
	}
	return renderPanelist(in, m)
}

// PanelistRescheduled tells an already-invited panelist the start moved.
func PanelistRescheduled(in Invite) (subject, text, html string) {
	lead := quoted(in.Topic) + " has moved to a new time. You're still on the panel."
	m := panelistMail{
		Subject:   "New time: " + strings.TrimSpace(in.Topic),
		Preheader: lead,
		Eyebrow:   "New time",
		Heading:   strings.TrimSpace(in.Topic),
		Lead:      lead,
		When:      in.WhenText,
		WhenLabel: "New time",
		Was:       in.WasText,
		LinkLabel: "Your stage link hasn't changed:",
		Button:    "Join the stage",
		URL:       in.StageURL,
		Notes:     []string{signInNote(in)},
	}
	if in.Calendar {
		m.Notes = append(m.Notes, "The attached calendar file moves the event already in your calendar.")
	}
	return renderPanelist(in, m)
}

// PanelistCancelled tells an invited panelist the webinar was deleted before it ran. No
// link: there is no longer anything to join.
func PanelistCancelled(in Invite) (subject, text, html string) {
	lead := quoted(in.Topic) + " has been cancelled."
	if in.WhenText != "" {
		lead = quoted(in.Topic) + ", scheduled for " + in.WhenText + ", has been cancelled."
	}
	note := "You don't need to do anything."
	if in.Calendar {
		note += " The attached calendar file removes the event from your calendar."
	} else {
		note += " If you added it to your calendar, you can remove it."
	}
	m := panelistMail{
		Subject:   "Cancelled: " + strings.TrimSpace(in.Topic),
		Preheader: lead,
		Eyebrow:   "Cancelled",
		Heading:   strings.TrimSpace(in.Topic),
		Lead:      lead,
		Notes:     []string{note},
		Cancelled: true,
	}
	return renderPanelist(in, m)
}

func renderPanelist(in Invite, m panelistMail) (subject, text, html string) {
	m.Greeting = panelistGreeting(in.Name)
	m.SignOff = "Thanks,"
	m.Signer = signer(in)
	m.Product = productName(in.Product)

	var b strings.Builder
	b.WriteString(m.Greeting + "\n\n")
	b.WriteString(m.Lead + "\n\n")
	if m.When != "" && !m.Cancelled {
		fmt.Fprintf(&b, "%s: %s\n", m.WhenLabel, m.When)
		if m.Was != "" {
			fmt.Fprintf(&b, "Was: %s\n", m.Was)
		}
		b.WriteString("\n")
	}
	if m.URL != "" {
		b.WriteString(m.LinkLabel + "\n" + m.URL + "\n\n")
	}
	for _, n := range m.Notes {
		b.WriteString(n + "\n\n")
	}
	b.WriteString(m.SignOff + "\n" + m.Signer + "\n")

	var hb bytes.Buffer
	if err := panelistHTML.Execute(&hb, panelistView{panelistMail: m, Initial: string([]rune(m.Product)[0]), MSO: msoFonts}); err != nil {
		return m.Subject, b.String(), ""
	}
	return m.Subject, b.String(), hb.String()
}

type panelistView struct {
	panelistMail
	Initial string
	MSO     template.HTML
}
