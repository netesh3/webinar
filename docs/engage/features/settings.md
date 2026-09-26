# Settings

**Status:** partial — WhatsApp lives on Account; Engage settings screen is
the mock  
**Mock:** `settings.html`, `settings-channels.html`

## Purpose

Channel health, plan copy ($149 ≠ Meta fees), team/SLA, feature visibility.

## Done looks like

- **Channels:** same Connect card as Account ([connect-whatsapp](connect-whatsapp.md)).
- **Team / SLA:** [team-sla](team-sla.md). Plan E. Not optional.
- **Guardrails:** opt-out keywords, dispatch cap, 24 h session fallback template, quiet hours, hash phones in logs after 90 days. Plan I. The fallback template is what a free-form journey step sends when the window is closed.
- **Reminders:** [reminders](reminders.md) templates.
- Plain sentence: Meta bills the connected WABA; Engage is software.

## Route

`/host/engage/settings` (and `/settings/channels`). Do not duplicate
password/MFA here — that’s Account in Webinar Liv. Link out.

## Calls

WhatsApp status is already on `GET /api/account` (or equivalent). Don’t
add a second “am I connected” endpoint.
