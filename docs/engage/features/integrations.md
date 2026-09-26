# Integrations (field mapping)

**Status:** planned  
**Mock:** `integrations.html` — mapping **hidden until click**

## Purpose

Tell Engage how webinar / contact / attendance fields fill template `{{n}}`,
and connect the sources the mock lists. Plan I in [PLANS.md](../PLANS.md).
Registration upsert stays the native path; Sheets, webhook, HubSpot, and
Zapier are additional enroll paths into the same contact + journey APIs.

## Done looks like

- Default tokens already used in reminders/broadcasts (`topic`, `when`,
  name, host name).
- Settings card: “Webinar Liv field mapping” — collapsed. Expand to a
  table: template variable → source field.
- Stored on the host (`crm_host_settings.template_map` JSON) so every
  send path (`Render` / param resolve) uses one function.

## Coupling

This **is** the coupling UI. If the host never opens it, defaults apply.
Engage still works with zero webinars (only contact name / phone).

## Calls

GET settings with Account/WhatsApp. PUT mapping once. Not on inbox poll.

## Also on this screen (plan I)

- Field map for the eight mock rows, including `Attendance.watch_minutes`, plus test payload.
- Google Calendar for the VIP session blueprint.
- Google Sheets: new row → contact, optional journey enroll.
- Custom webhook: HMAC, signed URL, same enroll API.
- HubSpot: stage sync both ways, enroll on stage change.
- Zapier: triggers and actions. Zapier does not walk journey steps.
