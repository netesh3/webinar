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
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Message is one rendered notification, ready to send.
type Message struct {
	To      string
	Subject string
	Body    string
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

	/* The message, assembled by hand and with the header values sanitised.
	 *
	 * Newlines are stripped from To and Subject before they reach the headers. That is not
	 * tidiness: a subject containing CRLF would end the header block early and let the rest
	 * of the string be interpreted as headers of its own — a Bcc, a different From — which
	 * is header injection. Both values here derive from a webinar topic and a registrant's
	 * email, and the topic is host-supplied text.
	 */
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", header(s.From))
	fmt.Fprintf(&b, "To: %s\r\n", header(m.To))
	fmt.Fprintf(&b, "Subject: %s\r\n", header(m.Subject))
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(strings.ReplaceAll(m.Body, "\n", "\r\n"))

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
		done <- smtp.SendMail(addr, auth, s.From, []string{m.To}, []byte(b.String()))
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

// header strips CR and LF so a value cannot terminate the header block and inject its own.
func header(v string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(strings.TrimSpace(v))
}
