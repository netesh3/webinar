package notify

import (
	"strings"
	"unicode"
)

// HostRequestRecipient is the inbox that hears someone asked to host.
// It is this address, not a configured contact, because that is who reviews
// the request. SMTP From stays the configured sender; this is only To.
const HostRequestRecipient = "webinarliv@gmail.com"

// HostRequestNotice is the account that asked to host.
type HostRequestNotice struct {
	Name   string
	Email  string
	Phone  string
	UserID string
}

// HostRequestEmail renders the note sent to HostRequestRecipient.
//
// Subject and body both carry the name, the account email, the phone, the
// user id, and that they requested hosting. Reply-To is the caller's job:
// this only renders the words.
func HostRequestEmail(n HostRequestNotice) (subject, body string) {
	name := strings.TrimSpace(n.Name)
	email := strings.TrimSpace(n.Email)
	phone := strings.TrimSpace(n.Phone)
	id := strings.TrimSpace(n.UserID)
	subject = oneLine(name + " requested hosting (" + email + ", " + phone + ", " + id + ")")
	body = name + " requested hosting.\r\n\r\n" +
		"Name: " + name + "\r\n" +
		"Account email: " + email + "\r\n" +
		"Phone: " + phone + "\r\n" +
		"User id: " + id + "\r\n"
	return subject, body
}

// oneLine keeps a header value on one line. A name with a newline must not
// become a second header.
func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}
