package notify

import (
	"bytes"
	"fmt"
	"html/template"
	"strings"
	"unicode"
	"unicode/utf8"
)

/* The welcome email: sent once, when an account is created.
 *
 * Its whole job is to make somebody who has just signed up feel welcome, and to tell them
 * the truth about what happens next. The truth, at the time of writing: a new account can
 * attend and host straight away (handleSignup creates every account host-capable), and
 * the things an administrator does switch on per account are the extras in
 * types.Features. So the copy says "you're ready now" AND "we'll be in touch to help you
 * set up and switch on extras" — never "wait for us to give you access", which would
 * make somebody sit on an account that already works.
 *
 * Rendered with html/template so the one piece of user-supplied text, the name, is
 * escaped by construction rather than by remembering to.
 */

// Welcome carries everything the welcome email needs. Assembled by the caller.
type Welcome struct {
	Product      string // the configured product name, e.g. "Webinar Liv"
	Name         string // the account's display name; may be empty (Google gives none sometimes)
	Email        string // the address the account was created with
	DashboardURL string // absolute; where the button goes
	ContactEmail string
	ContactPhone string // display form, e.g. "+91-9852411280"
}

// FirstName is the first word of a display name, or "" when there is nothing usable.
//
// Capped in length because it goes into a subject line, and a pasted paragraph in the
// name field should not become one. An address typed as a name is not a first name.
func FirstName(name string) string {
	fields := strings.Fields(name)
	if len(fields) == 0 {
		return ""
	}
	first := strings.TrimFunc(fields[0], func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && !unicode.IsMark(r)
	})
	if first == "" || strings.Contains(first, "@") {
		return ""
	}
	if utf8.RuneCountInString(first) > 40 {
		first = string([]rune(first)[:40])
	}
	return first
}

// TelURI turns a displayed phone number into a tel: target: the digits, keeping a
// leading plus. "+91-9852411280" → "tel:+919852411280".
func TelURI(phone string) string {
	var b strings.Builder
	for i, r := range strings.TrimSpace(phone) {
		if r >= '0' && r <= '9' || (r == '+' && i == 0) {
			b.WriteRune(r)
		}
	}
	return "tel:" + b.String()
}

// WelcomeEmail renders the subject, the plain-text body and the HTML body.
func WelcomeEmail(w Welcome) (subject, text, html string) {
	product := strings.TrimSpace(w.Product)
	if product == "" {
		product = "Webinar Liv"
	}
	first := FirstName(w.Name)
	/* A Google sign-in without a profile name gets the address's local part as its name
	 * (auth.nameFromSupabaseClaims). "Hi priya.s92," reads like a mail merge gone wrong,
	 * so that is treated as no name at all. */
	if local, _, ok := strings.Cut(strings.TrimSpace(w.Email), "@"); ok &&
		strings.EqualFold(strings.TrimSpace(w.Name), local) {
		first = ""
	}

	subject = "Welcome to " + product
	if first != "" {
		subject += ", " + first
	}

	greetingName := first
	if greetingName == "" {
		greetingName = "there"
	}

	d := welcomeData{
		Welcome:   w,
		Product:   product,
		Greeting:  "Hi " + greetingName + ",",
		Preheader: welcomePreheader,
		Tel:       template.URL(TelURI(w.ContactPhone)),
		Mailto:    template.URL("mailto:" + strings.TrimSpace(w.ContactEmail)),
		Initial:   string([]rune(product)[0]),
		Steps:     welcomeSteps(product),
		MSO:       msoFonts,
	}

	var tb strings.Builder
	fmt.Fprintf(&tb, "%s\n\n", d.Greeting)
	fmt.Fprintf(&tb, "Thank you for choosing %s. We're really glad you're here.\n\n", product)
	tb.WriteString("Your account is ready, so you can join webinars and set up your own right away.\n\n")
	tb.WriteString("What happens next\n\n")
	for i, s := range d.Steps {
		fmt.Fprintf(&tb, "%d. %s: %s\n", i+1, s.Title, s.Text)
	}
	fmt.Fprintf(&tb, "\nGo to your dashboard:\n%s\n\n", w.DashboardURL)
	tb.WriteString("Need anything? We're here.\n")
	if e := strings.TrimSpace(w.ContactEmail); e != "" {
		fmt.Fprintf(&tb, "Email: %s\n", e)
	}
	if p := strings.TrimSpace(w.ContactPhone); p != "" {
		fmt.Fprintf(&tb, "Phone: %s\n", p)
	}
	fmt.Fprintf(&tb, "\nWarmly,\nThe %s team\n\n", product)
	tb.WriteString("--\n")
	fmt.Fprintf(&tb, "You're receiving this because a %s account was just created", product)
	if e := strings.TrimSpace(w.Email); e != "" {
		fmt.Fprintf(&tb, " with %s", e)
	}
	tb.WriteString(". If that wasn't you, let us know and we'll sort it out.\n")

	var hb bytes.Buffer
	if err := welcomeHTML.Execute(&hb, d); err != nil {
		// The template is a constant and the data is strings; this cannot fail at
		// runtime short of a bug, which the tests catch. Text-only is still a
		// complete message.
		return subject, tb.String(), ""
	}
	return subject, tb.String(), hb.String()
}

const welcomePreheader = "Thanks for choosing us. Your account is ready, and our team will be in touch shortly to help you get set up."

type welcomeStep struct{ Title, Text string }

func welcomeSteps(product string) []welcomeStep {
	return []welcomeStep{
		{"Look around", "Your account works now. Join a webinar you're invited to, or schedule your own from the dashboard."},
		{"We'll say hello", "Someone from the " + product + " team will reach out shortly to help you get set up."},
		{"Unlock the extras", "Tell us what you need and we'll switch on features like replay links and contact tools for your account."},
	}
}

type welcomeData struct {
	Welcome
	Product   string
	Greeting  string
	Preheader string
	Tel       template.URL
	Mailto    template.URL
	Initial   string
	Steps     []welcomeStep
	MSO       template.HTML
}

// msoFonts is an Outlook-only conditional comment, passed in as trusted HTML because
// html/template strips comments from the template itself. Without it Word's renderer
// falls back to Times New Roman on the system font stack.
const msoFonts = template.HTML(`<!--[if mso]><style>table,td,a,p,span,h1{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->`)

// Table layout and inline styles throughout: Outlook renders with Word's engine and
// Gmail strips most <style>. The <style> block is progressive enhancement only — the
// dark palette for Apple Mail / Outlook.com and the narrow-screen padding.
var welcomeHTML = template.Must(template.New("welcome").Funcs(template.FuncMap{
	"inc": func(i int) int { return i + 1 },
}).Parse(`<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Welcome to {{.Product}}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; }
  a { text-decoration: none; }
  @media (max-width: 600px) {
    .wl-outer { padding: 16px 10px !important; }
    .wl-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .wl-h1 { font-size: 24px !important; line-height: 31px !important; }
    .wl-btn table { width: 100% !important; }
    .wl-btn a { display: block !important; }
  }
  @media (prefers-color-scheme: dark) {
    .wl-bg { background-color: #0d1117 !important; }
    .wl-card { background-color: #161b22 !important; border-color: #2a313c !important; }
    .wl-ink { color: #f0f3f6 !important; }
    .wl-muted { color: #aab3bf !important; }
    .wl-faint { color: #7d8793 !important; }
    .wl-soft { background-color: #1c2533 !important; border-color: #2a3a55 !important; }
    .wl-num { background-color: #1f3a6e !important; color: #cfe0ff !important; }
    .wl-link { color: #7fb0ff !important; }
    .wl-rule { border-color: #2a313c !important; }
    .wl-hero { background-image: linear-gradient(135deg,#0a4fd9 0%,#2c6cf0 100%) !important; }
  }
</style>
{{.MSO}}
</head>
<body class="wl-bg" style="margin:0;padding:0;background-color:#f3f5f9;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f3f5f9;">{{.Preheader}}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" class="wl-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f5f9;">
<tr><td class="wl-outer" align="center" style="padding:40px 16px;">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 20px 4px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="30" height="30" align="center" valign="middle" bgcolor="#0b5cff" style="width:30px;height:30px;background-color:#0b5cff;border-radius:8px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;line-height:30px;">{{.Initial}}</td>
    <td class="wl-ink" style="padding-left:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;letter-spacing:-0.2px;color:#0f172a;">{{.Product}}</td>
  </tr></table>
</td></tr>

<tr><td class="wl-card" bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e3e7ef;border-radius:16px;overflow:hidden;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="wl-hero wl-pad" bgcolor="#0b5cff" style="background-color:#0b5cff;background-image:linear-gradient(135deg,#0b5cff 0%,#3b7bff 100%);border-radius:15px 15px 0 0;padding:34px 40px 32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p style="margin:0 0 12px 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#cfe0ff;">Welcome aboard</p>
    <h1 class="wl-h1" style="margin:0 0 10px 0;font-size:28px;line-height:35px;font-weight:700;letter-spacing:-0.5px;color:#ffffff;">Thank you for choosing {{.Product}}.</h1>
    <p style="margin:0;font-size:16px;line-height:24px;color:#e3ecff;">We're really glad you're here.</p>
  </td></tr>

  <tr><td class="wl-pad" style="padding:30px 40px 4px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p class="wl-ink" style="margin:0 0 10px 0;font-size:16px;line-height:24px;font-weight:600;color:#0f172a;">{{.Greeting}}</p>
    <p class="wl-muted" style="margin:0;font-size:16px;line-height:25px;color:#475467;">Your account is ready, so you can join webinars and set up your own right away.</p>
  </td></tr>

  <tr><td class="wl-pad" style="padding:22px 40px 4px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p class="wl-faint" style="margin:0 0 14px 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#667085;">What happens next</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    {{range $i, $s := .Steps}}
    <tr>
      <td width="28" valign="top" style="width:28px;padding:0 14px 16px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td class="wl-num" width="28" height="28" align="center" valign="middle" bgcolor="#eaf1ff" style="width:28px;height:28px;background-color:#eaf1ff;border-radius:14px;color:#0b5cff;font-size:13px;font-weight:700;line-height:28px;">{{inc $i}}</td>
        </tr></table>
      </td>
      <td valign="top" style="padding:3px 0 16px 0;">
        <p class="wl-ink" style="margin:0 0 2px 0;font-size:15px;line-height:22px;font-weight:600;color:#0f172a;">{{$s.Title}}</p>
        <p class="wl-muted" style="margin:0;font-size:14.5px;line-height:22px;color:#475467;">{{$s.Text}}</p>
      </td>
    </tr>
    {{end}}
    </table>
  </td></tr>

  <tr><td class="wl-pad wl-btn" align="left" style="padding:6px 40px 30px 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" bgcolor="#0b5cff" style="background-color:#0b5cff;border-radius:10px;">
        <a href="{{.DashboardURL}}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Go to your dashboard</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td class="wl-pad" style="padding:0 40px 32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" class="wl-soft" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f8ff" style="background-color:#f5f8ff;border:1px solid #dfe8fb;border-radius:12px;">
    <tr><td style="padding:18px 20px;">
      <p class="wl-ink" style="margin:0 0 4px 0;font-size:15px;line-height:22px;font-weight:600;color:#0f172a;">Need anything? We're here.</p>
      <p class="wl-muted" style="margin:0 0 12px 0;font-size:14px;line-height:21px;color:#475467;">Questions, a quick demo, or help with your first webinar? Just ask.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      {{if .ContactEmail}}<tr>
        <td class="wl-faint" style="padding:2px 12px 2px 0;font-size:13px;line-height:20px;color:#667085;">Email</td>
        <td style="padding:2px 0;font-size:14px;line-height:20px;"><a class="wl-link" href="{{.Mailto}}" style="color:#0b5cff;font-weight:600;text-decoration:none;">{{.ContactEmail}}</a></td>
      </tr>{{end}}
      {{if .ContactPhone}}<tr>
        <td class="wl-faint" style="padding:2px 12px 2px 0;font-size:13px;line-height:20px;color:#667085;">Phone</td>
        <td style="padding:2px 0;font-size:14px;line-height:20px;"><a class="wl-link" href="{{.Tel}}" style="color:#0b5cff;font-weight:600;text-decoration:none;">{{.ContactPhone}}</a></td>
      </tr>{{end}}
      </table>
    </td></tr>
    </table>
  </td></tr>

  <tr><td class="wl-pad" style="padding:0 40px 36px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p class="wl-muted" style="margin:0;font-size:15px;line-height:23px;color:#475467;">Warmly,<br><span class="wl-ink" style="font-weight:600;color:#0f172a;">The {{.Product}} team</span></p>
  </td></tr>
  </table>
</td></tr>

<tr><td align="center" style="padding:22px 24px 0 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <p class="wl-faint" style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:#8a94a6;">You're receiving this because a {{.Product}} account was just created{{if .Email}} with {{.Email}}{{end}}.<br>If that wasn't you, let us know and we'll sort it out.</p>
  <p class="wl-faint" style="margin:0;font-size:12px;line-height:18px;font-weight:600;color:#8a94a6;">{{.Product}}</p>
</td></tr>
</table>

</td></tr>
</table>
</body>
</html>
`))
