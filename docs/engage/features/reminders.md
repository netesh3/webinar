# Reminders (webinar notifications on WhatsApp)

**Status:** shipped  
**Code:** `store/crm_reminders.go`, `0044_whatsapp_reminders.sql`,
`handleCRMReminders`, schedule toggle on webinar options

## Purpose

The **coupling layer** that is not a journey: fixed kinds tied to a webinar
lifecycle, using the host’s chosen templates.

| Kind | When queued | Eligible |
| --- | --- | --- |
| `wa_registration_confirmed` | Register / approve path | Connected + opt-in + approved |
| `wa_reminder_24h` | Outbox due 24 h before start | Toggle on, webinar not ended/draft |
| `wa_reminder_1h` | 1 h before | same |
| `wa_replay` | Host publishes a recording | Exempt from ended filter and from the reminder toggle |

## Done looks like

Engage Settings or CRM reminders pane: pick a template + language + param
tokens per kind. Webinar Liv only has a boolean “WhatsApp reminders”.

Empty choice = don’t send that kind.

## Rules

Sweeper joins contact + host grant; skips without phone, opt-in, token, or
(for non-replay) if webinar ended/draft or toggle off. Failed sends retry
with backoff; skipped keeps a reason.

## Calls

`GET/PUT /crm/reminders` once on the settings/setup screen. Not on inbox poll.

## Tests

`crm_reminders_test.go`; replay exemption; confirmation on registration.
