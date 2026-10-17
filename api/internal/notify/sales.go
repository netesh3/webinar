package notify

import (
	"strings"
)

/* Sales chat mail: the note that brings an admin in, and an admin's reply to a
 * visitor who left. Plain text, like the host-request note: these are read by one
 * person each and should look like a person wrote them. */

// SalesHandoffNotice is what the admins are told when a visitor needs a person.
type SalesHandoffNotice struct {
	Visitor  string // name or email, or "A visitor"
	Email    string // where to reply, when the visitor left one
	Reason   string // why the assistant (or the visitor) asked for a person
	Question string // the visitor's last message
	Page     string
	Link     string // the conversation in the admin inbox
}

func SalesHandoffEmail(n SalesHandoffNotice) (subject, body string) {
	who := strings.TrimSpace(n.Visitor)
	if who == "" {
		who = "A visitor"
	}
	subject = oneLine("Sales chat: " + who + " needs a person — " + clip(firstNonEmpty(n.Reason, n.Question), 80))
	var b strings.Builder
	b.WriteString(who + " is waiting in the sales chat on webinarliv.com.\r\n\r\n")
	if n.Reason != "" {
		b.WriteString("Why: " + n.Reason + "\r\n")
	}
	if n.Question != "" {
		b.WriteString("Their question: \"" + n.Question + "\"\r\n")
	}
	if n.Email != "" {
		b.WriteString("Reply-to email: " + n.Email + "\r\n")
	} else {
		b.WriteString("No email left yet — join the chat while they are there.\r\n")
	}
	if n.Page != "" {
		b.WriteString("Page: " + n.Page + "\r\n")
	}
	b.WriteString("\r\nJoin the conversation: " + n.Link + "\r\n")
	b.WriteString("If they've left, your reply there goes to their email.\r\n")
	return subject, b.String()
}

// SalesReplyNotice is an admin's answer mailed to a visitor.
type SalesReplyNotice struct {
	VisitorName string
	AdminName   string
	Reply       string
	Question    string // the visitor's question, quoted under the reply
	ResumeLink  string // reopens the chat on the site
}

func SalesReplyEmail(n SalesReplyNotice) (subject, body string) {
	subject = "Re: your question on Webinar Liv"
	greet := "Hi"
	if name := strings.TrimSpace(n.VisitorName); name != "" {
		greet += " " + strings.Fields(name)[0]
	}
	var b strings.Builder
	b.WriteString(greet + ",\r\n\r\n")
	b.WriteString(strings.TrimSpace(n.Reply) + "\r\n\r\n")
	b.WriteString("— " + firstNonEmpty(strings.TrimSpace(n.AdminName), "The Webinar Liv team") + "\r\n\r\n")
	if n.Question != "" {
		b.WriteString("Your question:\r\n> " + strings.ReplaceAll(n.Question, "\n", "\n> ") + "\r\n\r\n")
	}
	b.WriteString("Continue the chat: " + n.ResumeLink + "\r\n")
	b.WriteString("Or just reply to this email.\r\n")
	return subject, b.String()
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func clip(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > max {
		return string(r[:max-1]) + "…"
	}
	return s
}
