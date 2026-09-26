# Templates

**Status:** shipped  
**Mock:** `templates.html`  
**Code:** `store/crm_templates.go`, `wa/send.go` (`Templates`, `SendTemplate`,
`Render`), `crm-templates.tsx`

## Purpose

Engage does not author templates. Meta does. Engage **caches** what Meta last
said so send, campaigns, journeys, and reminders can pick an approved template
without a Graph call on every keystroke.

## Done looks like

- List: name, language, category, status, body, `{{n}}` count, why unsendable.
- Refresh is a **button** (`GET /crm/templates?refresh=1`). Automatic refresh
  on every inbox poll is forbidden (WABA rate limit).
- Preview fills `{{n}}` locally with `wa.Render` / the web helper.
- Only `Sendable` templates appear in composers and wizards.

## Cache shape (`crm_templates`)

`(host_id, name, language)` identity. Sync is a **replace** in one
transaction (`ReplaceTemplates`). Stale names used by a reminder/drip are
skipped at send time with a reason, not crashed.

`unsupported` is empty when the template can be sent from here.

## Send

`POST /crm/contacts/{id}/send` with template name + language + params, or
body for free-form. Server is source of truth.

## Coupling

Reminder settings bind kinds (`wa_registration_confirmed`, `wa_reminder_24h`,
`wa_reminder_1h`, `wa_replay`) to a cached template. Webinar Liv schedule
toggle only decides **whether** those rows are eligible, not which template.

Merge fields: `topic`, `when`, name, etc. Mapping UI:
[integrations.md](integrations.md).

## Calls

One GET without `refresh` on Templates screen. Inbox/campaigns reuse that
payload from parent state when possible; they must still work if the host
landed on inbox first (lazy GET once).

## Tests

Sync replace; send refused if not approved / wrong param count / opted out.
