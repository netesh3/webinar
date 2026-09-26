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
interface.

### Events Webinar Liv already emits (do not invent new ones)

| When | What Engage does today | Code |
| --- | --- | --- |
| Guest registers (phone + opt-in) | Upsert `crm_contacts` | `ContactFromRegistration` |
| Registration approved | WhatsApp confirm may leave the outbox | reminder / notify sweep |
| Webinar ended | Drips with `ended` / `attended` / `no_show` enroll | `EnrollOnWebinarEnd` |
| Tag added | Drips with `tag_added` enroll | `EnrollOnTagAdded` |
| Recording made public | `wa_replay` queued if template chosen | notifications |

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
