# Reminders (webinar notifications on WhatsApp)

**Status:** shipped  
**Code:** `engage/crm_reminders.go`, `0044_whatsapp_reminders.sql`,
`0052_reminder_offsets.sql`, `handleCRMReminders`; per-webinar times and
toggles in the schedule form (`options.reminders`, `components/reminder-times.tsx`)

## Purpose

The **coupling layer** that is not a journey: fixed kinds tied to a webinar
lifecycle, using the host’s chosen templates.

| Kind | When queued | Eligible |
| --- | --- | --- |
| `wa_registration_confirmed` | Register / approve path | Connected + opt-in + approved |
| `wa_reminder` | One row per reminder time, due `starts_at - offset_min` | Toggle on, webinar not ended/draft |
| `wa_replay` | Host publishes a recording | Exempt from ended filter and from the reminder toggle |

## Done looks like

Engage Settings or CRM reminders pane: pick a template + language + param
tokens per kind. One template covers every reminder time; the `starts_in`
merge field fills in “in 1 hour”, “in 24 hours”, “in 10 minutes”.

Each webinar has its own reminder times (`options.reminders`, minutes before
the start): up to 3, between 1 minute and 30 days, default `[1440, 60]`. Set
when the webinar is created, changed in its edit form. Email and WhatsApp use
the same times; each channel's toggle decides whether it sends them.

Empty choice = don’t send that kind.

## Editing a webinar

On every save (`PATCH /api/host/webinars/{id}`), for email and WhatsApp alike:

- a time removed from the list: its unsent rows are deleted;
- a time added: queued for everybody already registered and approved;
- the start moved: unsent rows move with it (`starts_at - offset_min`);
- a row that the move puts in the past is deleted, not sent late;
- a channel's toggle off: its unsent reminders are deleted, and turning it
  back on and saving queues them again.

Rows already due when the save lands are left to the outbox.

## Rules

Sweeper joins contact + host grant; skips without phone, opt-in, token, or
(for non-replay) if webinar ended/draft or toggle off. Failed sends retry
with backoff; skipped keeps a reason.

## Calls

`GET/PUT /crm/reminders` once on the settings/setup screen. Not on inbox poll.

## Tests

`crm_reminders_test.go`; replay exemption; confirmation on registration.
