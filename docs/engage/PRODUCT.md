# Engage product and coupling

## Product

Engage is a self-serve WhatsApp CRM for people who already have (or will
create) a WhatsApp Business Account. They connect that account once. Meta
bills template messages to **their** WABA (per delivered message since July
2025). Engage charges a software fee ($149 in the mock). The two invoices must
never mix.

Engage can be sold to someone who never hosts a webinar. Inbox, contacts,
templates, campaigns, journeys, and bots do not require a webinar row.

## Separate, not forked

Same git repo, same Cloud Run binary, same Postgres, same `webcast_session`.
Different:

- **Navigation.** Engage has its own chrome (`docs/mockups/cursor`). Webinar
  Liv keeps Host Webinar / room / recordings.
- **Routes.** Engage lives under `/host/engage/*`. `/host/crm` redirects there.
- **Billing flag.** An account can have webinars, Engage, both, or (later)
  neither. Do not hide Engage behind “has hosted a webinar”.
- **Copy.** Product name is Engage. Do not say WebinarLiv on Engage screens.

There is no second Go service and no second database in v1.

## Coupling contract

Webinar Liv may **emit events**. Engage may **subscribe**. That is the whole
interface. In code it is the `api.Engage` interface and the `@/engage` web
entry point, both enforced by tests and lint: [`MODULES.md`](MODULES.md).

### Events Webinar Liv already emits (do not invent new ones)

| When | What Engage does today | Code |
| --- | --- | --- |
| Guest registers (phone + opt-in) | Upsert `crm_contacts` | `Engage.OnRegistered` |
| Registration approved / declined | WhatsApp confirm leaves, or is skipped | `Engage.OnRegistrationsDecided` |
| Webinar rescheduled | WhatsApp 24h / 1h reminders move | `Engage.OnRescheduled` |
| Webinar ended | Unsent reminders skipped; `ended` / `attended` / `no_show` drips enroll | `Engage.OnEnded` |
| Tag added | Drips with `tag_added` enroll | inside Engage (not a webinar event) |
| Recording made public | `wa_replay` queued if template chosen | `Engage.OnRecordingPublished` |

### UI hooks (Webinar Liv → Engage)

| Place | Hook |
| --- | --- |
| Attendees tab | “View in CRM” → `/host/engage/contacts?webinar=<slug>` |
| Schedule form | “WhatsApp reminders” toggle; disabled until Connect |
| Register form | Phone + “WhatsApp updates from {host}” (off by default) |
| Account | Connect WhatsApp card (shared; it is how Engage gets a number) |

### What Engage must not do

- Start, end, or record a webinar.
- Read LiveKit, chat, or polls.
- Put webinar chrome in the Engage sidebar.

### What Webinar Liv must not do

- Send WhatsApp except through Engage’s outbox (`notifications` + `wa` client).
- Store a second copy of the WABA token.
- Bypass opt-out / 24h / template rules.

### Optional later: Engage without this frontend

If Engage is ever served on its own hostname, the coupling stays the same:
HTTP to the same Cloud Run API, same cookie or a scoped token, same
`host_id`. Do not split the CRM schema into another Postgres to “make it
separate”.

## Tenancy

Still `host_id` = `users.id`. No organisations table in v1. A “team” in
Engage is other `users` the host has invited, scoped under that host
([team-sla](features/team-sla.md)).

## Non-goals (product)

- Unofficial WhatsApp (QR, WAHA, Baileys, whatsapp-web.js).
- Paying Meta on behalf of the host.
- A Zapier-style app directory of our own. Zapier itself is a connector in plan I.
- Forking WACRM, Whatomate, Frappe CRM, or DeskcommCRM.
