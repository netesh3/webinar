package notify

import "html/template"

// panelistHTML follows the welcome email's layout and palette (see welcomeHTML for why
// tables and inline styles). The topic, host and panelist names are user text and are
// escaped by html/template.
var panelistHTML = template.Must(template.New("panelist").Parse(`<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{{.Subject}}</title>
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
    .wl-link { color: #7fb0ff !important; }
    .wl-hero { background-image: linear-gradient(135deg,#0a4fd9 0%,#2c6cf0 100%) !important; }
    .wl-hero-off { background-color: #2a313c !important; background-image: none !important; }
  }
</style>
{{.MSO}}
</head>
<body class="wl-bg" style="margin:0;padding:0;background-color:#f3f5f9;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f3f5f9;">{{.Preheader}}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
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
  {{if .Cancelled}}
  <tr><td class="wl-hero-off wl-pad" bgcolor="#475467" style="background-color:#475467;border-radius:15px 15px 0 0;padding:34px 40px 32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p style="margin:0 0 12px 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#d0d5dd;">{{.Eyebrow}}</p>
    <h1 class="wl-h1" style="margin:0;font-size:28px;line-height:35px;font-weight:700;letter-spacing:-0.5px;color:#ffffff;text-decoration:line-through;">{{.Heading}}</h1>
  </td></tr>
  {{else}}
  <tr><td class="wl-hero wl-pad" bgcolor="#0b5cff" style="background-color:#0b5cff;background-image:linear-gradient(135deg,#0b5cff 0%,#3b7bff 100%);border-radius:15px 15px 0 0;padding:34px 40px 32px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p style="margin:0 0 12px 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#cfe0ff;">{{.Eyebrow}}</p>
    <h1 class="wl-h1" style="margin:0;font-size:28px;line-height:35px;font-weight:700;letter-spacing:-0.5px;color:#ffffff;">{{.Heading}}</h1>
  </td></tr>
  {{end}}

  <tr><td class="wl-pad" style="padding:30px 40px 4px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p class="wl-ink" style="margin:0 0 10px 0;font-size:16px;line-height:24px;font-weight:600;color:#0f172a;">{{.Greeting}}</p>
    <p class="wl-muted" style="margin:0;font-size:16px;line-height:25px;color:#475467;">{{.Lead}}</p>
  </td></tr>

  {{if and .When (not .Cancelled)}}
  <tr><td class="wl-pad" style="padding:22px 40px 4px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" class="wl-soft" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f5f8ff" style="background-color:#f5f8ff;border:1px solid #dfe8fb;border-radius:12px;">
    <tr><td style="padding:16px 20px;">
      <p class="wl-faint" style="margin:0 0 4px 0;font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#667085;">{{.WhenLabel}}</p>
      <p class="wl-ink" style="margin:0;font-size:16px;line-height:24px;font-weight:600;color:#0f172a;">{{.When}}</p>
      {{if .Was}}<p class="wl-faint" style="margin:8px 0 0 0;font-size:14px;line-height:20px;color:#667085;">Was: <span style="text-decoration:line-through;">{{.Was}}</span></p>{{end}}
    </td></tr>
    </table>
  </td></tr>
  {{end}}

  {{if .URL}}
  <tr><td class="wl-pad wl-btn" align="left" style="padding:24px 40px 8px 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" bgcolor="#0b5cff" style="background-color:#0b5cff;border-radius:10px;">
        <a href="{{.URL}}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">{{.Button}}</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td class="wl-pad" style="padding:6px 40px 0 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p class="wl-faint" style="margin:0;font-size:13px;line-height:19px;color:#667085;word-break:break-all;">Or open <a class="wl-link" href="{{.URL}}" style="color:#0b5cff;text-decoration:none;">{{.URL}}</a></p>
  </td></tr>
  {{end}}

  <tr><td class="wl-pad" style="padding:22px 40px 8px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    {{range .Notes}}<p class="wl-muted" style="margin:0 0 12px 0;font-size:15px;line-height:23px;color:#475467;">{{.}}</p>{{end}}
  </td></tr>

  <tr><td class="wl-pad" style="padding:0 40px 36px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <p class="wl-muted" style="margin:0;font-size:15px;line-height:23px;color:#475467;">{{.SignOff}}<br><span class="wl-ink" style="font-weight:600;color:#0f172a;">{{.Signer}}</span></p>
  </td></tr>
  </table>
</td></tr>

<tr><td align="center" style="padding:22px 24px 0 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <p class="wl-faint" style="margin:0;font-size:12px;line-height:18px;font-weight:600;color:#8a94a6;">{{.Product}}</p>
</td></tr>
</table>

</td></tr>
</table>
</body>
</html>
`))
