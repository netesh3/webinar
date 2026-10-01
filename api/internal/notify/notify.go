// Package notify renders and delivers the messages the approval workflow owes people.
//
// Two things live here and they are deliberately separate:
//
//	rendering    turning "this person was approved" into a subject and a body that contains
//	             their own join link. Pure, testable, no network.
//	delivery     handing that to a transport. Fallible, and allowed to be absent.
//
// WHY A TRANSPORT INTERFACE rather than just calling an SMTP library. This deployment has no
// mail credentials and may never have any — it is one EC2 box, and a coaching business running
// five webinars does not necessarily want to operate a mail server or pay for a sending
// service. The workflow still has to be complete and auditable in that situation.
//
// So an unconfigured deployment gets Discard, which records the message as 'skipped' with the
// reason. Nothing silently vanishes, the host's in-app alert still works, and adding
// SMTP_HOST later starts sending without touching a line of application code.
//
// The alternative — writing the SMTP call inline and letting it error on every approval — makes
// a working feature look broken, which is how a real send failure ends up being ignored.
package notify

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"regexp"
	"strings"
	"time"
)

// Message is one rendered notification, ready to send.
type Message struct {
	To      string
	Subject string
	Body    string
	// HTML is an optional rich alternative to Body. When set, the message is sent as
	// multipart/alternative and Body remains the plain-text part, so a client that
	// cannot or will not render HTML still gets the whole message.
	HTML string
	// ICS is an optional iCalendar payload. Empty means a plain-text message.
	ICS     string
	ICSName string
	// ReplyTo is optional. Empty leaves the header off, so a reply falls through
	// to From. When set, it is the host inbox (InboxAddress). It is never copied
	// into From or the SMTP envelope: those stay SMTP.From, which for Gmail must
	// be the authenticated account or a verified "Send mail as" alias.
	ReplyTo string
	// InReplyTo and References thread this message under an earlier one.
	// Both are Message-IDs, including the angle brackets. Empty leaves the
	// header off. Neither is copied into From.
	InReplyTo  string
	References string
}

// Transport delivers a message, or explains why it did not.
type Transport interface {
	Send(ctx context.Context, m Message) error
	// Configured reports whether this transport can actually deliver. Checked before a
	// send is attempted so "no mail server" is recorded as skipped rather than failed.
	Configured() bool
}

// ---------------------------------------------------------------- discard

// Discard is the transport for a deployment with no mail credentials.
type Discard struct{ Log *slog.Logger }

func (Discard) Configured() bool { return false }

// Send logs at INFO rather than WARN. On a deployment that has deliberately not configured
// mail, an approval is a normal event and a warning per approval trains operators to ignore
// warnings.
func (d Discard) Send(_ context.Context, m Message) error {
	if d.Log != nil {
		d.Log.Info("email not sent: no transport configured",
			"to", m.To, "subject", m.Subject)
	}
	return nil
}

// ---------------------------------------------------------------- smtp

// SMTP is a minimal sender over STARTTLS or implicit TLS, from the standard library.
//
// No dependency for this. The whole job is "connect, authenticate, hand over a message", the
// stdlib does it, and a mail library would bring a transitive tree into an image that is
// currently a single static binary.
type SMTP struct {
	Host     string // without the port
	Port     int
	Username string
	Password string
	From     string
	Log      *slog.Logger
}

func (s SMTP) Configured() bool { return s.Host != "" && s.From != "" }

func (s SMTP) Send(ctx context.Context, m Message) error {
	if !s.Configured() {
		return fmt.Errorf("smtp: not configured")
	}
	addr := net.JoinHostPort(s.Host, fmt.Sprint(s.Port))
	msg := s.compose(m, time.Now())

	var auth smtp.Auth
	if s.Username != "" {
		auth = smtp.PlainAuth("", s.Username, s.Password, s.Host)
	}

	// smtp.SendMail does not take a context, so the deadline is enforced by running it in a
	// goroutine and abandoning the result. The connection is closed by the runtime when the
	// goroutine finishes; the point is that an unresponsive mail server cannot hold an
	// approval request open indefinitely.
	done := make(chan error, 1)
	go func() {
		done <- smtp.SendMail(addr, auth, s.envelopeFrom(), []string{m.To}, []byte(msg))
	}()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("smtp send: %w", err)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("smtp send: %w", ctx.Err())
	}
}

/* envelopeFrom is the bare address for MAIL FROM. SMTP_FROM may carry a display name
 * ("Webinar Liv <hello@example.com>") so the inbox shows the product rather than an
 * address; the envelope must not. A value that does not parse is used as given, which is
 * what this did before display names were accepted. */
func (s SMTP) envelopeFrom() string {
	if a, err := mail.ParseAddress(s.From); err == nil {
		return a.Address
	}
	return s.From
}

// compose assembles the RFC 5322 message. Separate from Send so its shape can be tested
// without a mail server.
func (s SMTP) compose(m Message, now time.Time) string {
	/* The message, assembled by hand and with the header values sanitised.
	 *
	 * Newlines are stripped from To and Subject before they reach the headers. That is not
	 * tidiness: a subject containing CRLF would end the header block early and let the rest
	 * of the string be interpreted as headers of its own — a Bcc, a different From — which
	 * is header injection. Both values here derive from a webinar topic and a registrant's
	 * email, and the topic is host-supplied text.
	 */
	from := header(s.From)
	if a, err := mail.ParseAddress(s.From); err == nil {
		from = a.String()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", header(m.To))
	// Reply-To is omitted when empty or unparsable. A value that does not parse
	// as an address is dropped rather than written raw: the field is host-adjacent
	// data, and a bad value must not become a second header.
	if reply := header(m.ReplyTo); reply != "" {
		if a, err := mail.ParseAddress(reply); err == nil {
			fmt.Fprintf(&b, "Reply-To: %s\r\n", a.String())
		}
	}
	// Q-encoded when it is not plain ASCII: a subject carrying a registrant's name in
	// Devanagari or an accented Latin name is otherwise raw 8-bit in a header, which
	// some relays reject and some clients show as mojibake. ASCII is left unchanged.
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", header(m.Subject)))
	if id := header(m.InReplyTo); id != "" {
		fmt.Fprintf(&b, "In-Reply-To: %s\r\n", id)
	}
	if refs := header(m.References); refs != "" {
		fmt.Fprintf(&b, "References: %s\r\n", refs)
	}
	fmt.Fprintf(&b, "Date: %s\r\n", now.Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")
	boundary := "wl" + fmt.Sprintf("%d", now.UnixNano())
	if ics := strings.TrimSpace(m.ICS); ics != "" {
		name := m.ICSName
		if name == "" {
			name = "invite.ics"
		}
		fmt.Fprintf(&b, "Content-Type: multipart/mixed; boundary=%s\r\n\r\n", boundary)
		fmt.Fprintf(&b, "--%s\r\n", boundary)
		writeBody(&b, m, boundary+"alt")
		b.WriteString("\r\n")
		fmt.Fprintf(&b, "--%s\r\n", boundary)
		// The header's method must match the file's METHOD, or Outlook ignores a cancellation.
		fmt.Fprintf(&b, "Content-Type: text/calendar; charset=utf-8; method=%s; name=%q\r\n",
			header(ICSMethod(ics)), header(name))
		fmt.Fprintf(&b, "Content-Disposition: attachment; filename=%q\r\n\r\n", header(name))
		// Normalised first: ICSFile already writes CRLF, and a blind \n → \r\n made \r\r\n.
		b.WriteString(strings.ReplaceAll(strings.ReplaceAll(ics, "\r\n", "\n"), "\n", "\r\n"))
		if !strings.HasSuffix(ics, "\r\n") {
			b.WriteString("\r\n")
		}
		fmt.Fprintf(&b, "--%s--\r\n", boundary)
	} else {
		writeBody(&b, m, boundary)
	}
	return b.String()
}

/* writeBody writes the Content-Type header and the readable content of a message: plain
 * text alone, or text and HTML as multipart/alternative. Text comes first because
 * RFC 2046 orders alternatives from least to most preferred, and clients pick the last one
 * they can render.
 *
 * The HTML part is quoted-printable, not raw 8-bit: SMTP caps a line at 998 octets, and a
 * templated email with inline styles can exceed that on a single line.
 */
func writeBody(b *strings.Builder, m Message, boundary string) {
	if strings.TrimSpace(m.HTML) == "" {
		b.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
		b.WriteString(strings.ReplaceAll(m.Body, "\n", "\r\n"))
		return
	}
	fmt.Fprintf(b, "Content-Type: multipart/alternative; boundary=%s\r\n\r\n", boundary)
	fmt.Fprintf(b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	b.WriteString(quotedPrintable(m.Body))
	fmt.Fprintf(b, "\r\n--%s\r\n", boundary)
	b.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	b.WriteString(quotedPrintable(m.HTML))
	fmt.Fprintf(b, "\r\n--%s--\r\n", boundary)
}

func quotedPrintable(s string) string {
	var out strings.Builder
	w := quotedprintable.NewWriter(&out)
	_, _ = w.Write([]byte(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")))
	_ = w.Close()
	return out.String()
}

// header strips CR and LF so a value cannot terminate the header block and inject its own.
func header(v string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(v))
}

/* InboxAddress is local@webinarliv.com, the per-host Reply-To.
 *
 * It is not a From address. Outbound mail is one shared mailbox (production: Gmail);
 * Gmail rejects or rewrites a From it did not authenticate. Empty, or anything that
 * is not a single dot-atom local part, returns "" so the message is sent with no
 * Reply-To. The pattern is lowercase letters, digits and hyphens, matching
 * users.inbox_local. Callers set that column once the address can receive.
 */
var inboxLocal = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`)

func InboxAddress(local string) string {
	local = strings.ToLower(strings.TrimSpace(local))
	if !inboxLocal.MatchString(local) {
		return ""
	}
	return local + "@webinarliv.com"
}
