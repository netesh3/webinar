package notify

import (
	stdhtml "html"
	"os"
	"strings"
	"testing"
	"time"
)

func sampleWelcome() Welcome {
	return Welcome{
		Product:      "Webinar Liv",
		Name:         "Priya Sharma",
		Email:        "priya@example.com",
		DashboardURL: "https://app.example.com/host",
		ContactEmail: "webinarliv@gmail.com",
		ContactPhone: "+91-9852411280",
	}
}

func TestWelcomeRendersSubjectTextAndHTML(t *testing.T) {
	subject, text, html := WelcomeEmail(sampleWelcome())

	if subject != "Welcome to Webinar Liv, Priya" {
		t.Errorf("subject = %q", subject)
	}
	if html == "" {
		t.Fatal("no HTML part")
	}
	for name, body := range map[string]string{"text": text, "html": stdhtml.UnescapeString(html)} {
		for _, want := range []string{
			"Hi Priya,",
			"Thank you for choosing Webinar Liv",
			"https://app.example.com/host",
			"webinarliv@gmail.com",
			"+91-9852411280",
			"The Webinar Liv team",
			"priya@example.com",
		} {
			if !strings.Contains(body, want) {
				t.Errorf("%s part is missing %q", name, want)
			}
		}
	}
	for _, want := range []string{
		`href="mailto:webinarliv@gmail.com"`,
		`href="tel:&#43;919852411280"`,
		`name="color-scheme" content="light dark"`,
		"max-width:560px",
		"#0b5cff",
		welcomePreheader,
		"<!--[if mso]>",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("HTML is missing %q", want)
		}
	}
}

// The copy must not say the account is on hold: a new account can attend immediately.
func TestWelcomeDoesNotSayAccessIsPending(t *testing.T) {
	_, text, html := WelcomeEmail(sampleWelcome())
	for _, body := range []string{text, html} {
		lower := strings.ToLower(body)
		for _, bad := range []string{"give you access", "once approved", "pending approval", "until we"} {
			if strings.Contains(lower, bad) {
				t.Errorf("copy says %q, but new accounts can already sign in and attend", bad)
			}
		}
		if !strings.Contains(lower, "your account is ready") {
			t.Error("copy should say the account is ready now")
		}
	}
}

func TestWelcomeEscapesTheName(t *testing.T) {
	w := sampleWelcome()
	w.Name = `<script>alert(1)</script> "Mallory"`
	w.Email = `x"><img src=x onerror=alert(1)>@example.com`
	_, _, html := WelcomeEmail(w)
	for _, bad := range []string{"<script>", "<img src=x", `"><img`} {
		if strings.Contains(html, bad) {
			t.Errorf("unescaped user input %q in HTML", bad)
		}
	}
}

func TestWelcomeFallsBackWhenThereIsNoName(t *testing.T) {
	for _, name := range []string{"", "   ", "priya@example.com", "!!!", "priya"} {
		w := sampleWelcome()
		w.Name = name
		subject, text, html := WelcomeEmail(w)
		if subject != "Welcome to Webinar Liv" {
			t.Errorf("name %q: subject = %q", name, subject)
		}
		if !strings.HasPrefix(text, "Hi there,") || !strings.Contains(html, "Hi there,") {
			t.Errorf("name %q: expected the 'Hi there,' greeting", name)
		}
	}
}

func TestWelcomeUsesTheConfiguredProduct(t *testing.T) {
	w := sampleWelcome()
	w.Product = "Acme Live"
	subject, text, html := WelcomeEmail(w)
	if !strings.Contains(subject, "Acme Live") || !strings.Contains(text, "The Acme Live team") ||
		!strings.Contains(html, "The Acme Live team") {
		t.Error("product name not used throughout")
	}
	if strings.Contains(text+html, "Webinar Liv") {
		t.Error("hard-coded product name leaked into a configured one")
	}
}

func TestFirstNameAndTel(t *testing.T) {
	cases := map[string]string{
		"Priya Sharma": "Priya", "  asha ": "asha", "José Álvarez": "José",
		"प्रिया शर्मा": "प्रिया", "": "", "a@b.co": "",
	}
	for in, want := range cases {
		if got := FirstName(in); got != want {
			t.Errorf("FirstName(%q) = %q, want %q", in, got, want)
		}
	}
	if got := TelURI("+91-9852411280"); got != "tel:+919852411280" {
		t.Errorf("TelURI = %q", got)
	}
	if got := TelURI(" (080) 1234 5678 "); got != "tel:08012345678" {
		t.Errorf("TelURI = %q", got)
	}
}

func TestComposeSendsHTMLAsAlternative(t *testing.T) {
	subject, text, html := WelcomeEmail(sampleWelcome())
	s := SMTP{Host: "smtp.example.test", Port: 587, From: "Webinar Liv <hello@example.test>"}
	msg := s.compose(Message{To: "priya@example.com", Subject: subject, Body: text, HTML: html}, time.Unix(0, 0))

	if !strings.Contains(msg, "Content-Type: multipart/alternative;") {
		t.Fatal("HTML message is not multipart/alternative")
	}
	if strings.Index(msg, "text/plain") > strings.Index(msg, "text/html") {
		t.Error("the plain-text part must come first")
	}
	if !strings.Contains(msg, `From: "Webinar Liv" <hello@example.test>`) {
		t.Errorf("display name not kept in From: %q", strings.SplitN(msg, "\r\n", 2)[0])
	}
	if s.envelopeFrom() != "hello@example.test" {
		t.Errorf("envelope sender = %q", s.envelopeFrom())
	}
	for _, line := range strings.Split(msg, "\r\n") {
		if len(line) > 998 {
			t.Fatalf("line of %d octets exceeds the SMTP limit", len(line))
		}
	}

	// A message without HTML is exactly the plain-text message it always was.
	plain := s.compose(Message{To: "a@example.com", Subject: "Hi", Body: "hello"}, time.Unix(0, 0))
	if strings.Contains(plain, "multipart") || !strings.Contains(plain, "Content-Type: text/plain; charset=utf-8\r\n\r\nhello") {
		t.Errorf("plain message changed shape:\n%s", plain)
	}
}

func TestComposeReplyTo(t *testing.T) {
	s := SMTP{Host: "h", From: "Webinar Liv <hello@example.test>"}
	with := s.compose(Message{
		To: "a@example.com", Subject: "Hi", Body: "hello", ReplyTo: "gsp@webinarliv.com",
	}, time.Unix(0, 0))
	if !strings.Contains(with, "Reply-To: <gsp@webinarliv.com>\r\n") &&
		!strings.Contains(with, "Reply-To: gsp@webinarliv.com\r\n") {
		t.Errorf("Reply-To missing:\n%s", with)
	}
	if strings.Contains(with, "From: gsp@") {
		t.Error("Reply-To must not replace From")
	}

	plain := s.compose(Message{To: "a@example.com", Subject: "Hi", Body: "hello"}, time.Unix(0, 0))
	if strings.Contains(plain, "Reply-To:") {
		t.Error("empty ReplyTo must not emit a header")
	}

	injected := s.compose(Message{
		To: "a@example.com", Subject: "Hi", Body: "hello",
		ReplyTo: "gsp@webinarliv.com\r\nBcc: victim@example.com",
	}, time.Unix(0, 0))
	if strings.Contains(injected, "Bcc:") {
		t.Error("Reply-To must not inject headers")
	}
}

func TestInboxAddress(t *testing.T) {
	if got := InboxAddress(" GSP "); got != "gsp@webinarliv.com" {
		t.Errorf("InboxAddress = %q", got)
	}
	for _, bad := range []string{"", "a b", "has@at", "bad!", "../x"} {
		if got := InboxAddress(bad); got != "" {
			t.Errorf("InboxAddress(%q) = %q, want empty", bad, got)
		}
	}
}

func TestComposeEncodesANonASCIISubject(t *testing.T) {
	s := SMTP{Host: "h", From: "a@example.test"}
	msg := s.compose(Message{To: "b@example.test", Subject: "Welcome to Webinar Liv, प्रिया", Body: "x"}, time.Unix(0, 0))
	if !strings.Contains(msg, "Subject: =?utf-8?q?") {
		t.Errorf("non-ASCII subject not encoded: %q", msg)
	}
}

/* Writes the rendered email for a visual check:
 *
 *	WELCOME_EMAIL_PREVIEW=/tmp/welcome-email.html go test ./internal/notify -run Preview
 */
func TestWelcomePreview(t *testing.T) {
	path := os.Getenv("WELCOME_EMAIL_PREVIEW")
	if path == "" {
		t.Skip("set WELCOME_EMAIL_PREVIEW to write the rendered email")
	}
	subject, text, html := WelcomeEmail(sampleWelcome())
	if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(strings.TrimSuffix(path, ".html")+".txt", []byte("Subject: "+subject+"\n\n"+text), 0o644); err != nil {
		t.Fatal(err)
	}
}
