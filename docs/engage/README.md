# Engage

Engage is the WhatsApp CRM product. It lives in this repo so it can share
auth, Postgres, and Cloud Run with Webinar Liv, but it is **not** Webinar Liv.

| | Webinar Liv | Engage |
| --- | --- | --- |
| Job | Host and join webinars | Talk to people on WhatsApp |
| Surface | `/host`, `/webinars`, room | `/host/engage` (today: `/host/crm`) |
| Plan | webinar hosting | $149/month; Meta template fees billed per message to the host’s WABA |
| Can run without the other | yes | yes — contacts, inbox, campaigns, bots need no webinar |

**Easy coupling** is a small, named set of events and UI hooks, not a merged
app. Spec: [`PRODUCT.md`](PRODUCT.md). In code: [`MODULES.md`](MODULES.md) —
`api/internal/engage` and `web/engage`, checked by tests and lint. **Building now:** [`V1.md`](V1.md) —
reminders and post-webinar follow-up. Full target (parked): [`PLANS.md`](PLANS.md).
Architecture, scale, and call budget: [`../ENGAGE-ARCHITECTURE.md`](../ENGAGE-ARCHITECTURE.md).
**Cloud Run RAM + Supabase pool:** [`SIZING.md`](SIZING.md).
Mocks: [`../mockups/cursor/`](../mockups/cursor/).

## Feature specs

| Spec | Status | What it is |
| --- | --- | --- |
| [Connect WhatsApp](features/connect-whatsapp.md) | shipped | Embedded Signup, host WABA, register PIN |
| [Dashboard](features/dashboard.md) | planned | One overview call; open queue + last campaign |
| [Inbox](features/inbox.md) | partial | Thread + send exist; shared queue / assign / 24h lock UX do not |
| [Contacts](features/contacts.md) | partial | List, search, thread, opt-out, webinar scope |
| [Tags and notes](features/tags-notes.md) | shipped | Labels, chips, notes; feature-flagged |
| [Pipelines](features/pipelines.md) | planned | Stages and owner on the contact |
| [Templates](features/templates.md) | shipped | Meta cache, send, reminders bind to names |
| [Campaigns](features/campaigns.md) | partial | Broadcasts + audience; five-step wizard is UI |
| [Journeys](features/journeys.md) | partial | Graph in plans A–C; linear drips shipped |
| [Bots](features/bots.md) | partial | Keyword / any-message flows; list editor, not canvas |
| [Reminders](features/reminders.md) | shipped | Webinar confirm / 24h / 1h / replay on WhatsApp |
| [Team and SLA](features/team-sla.md) | planned | Assignees under `host_id`; skip if host-only |
| [Analytics](features/analytics.md) | planned | SLA + campaign funnel from existing rows |
| [Integrations](features/integrations.md) | planned | Webinar field → template `{{n}}`; no Zapier v1 |
| [Settings](features/settings.md) | partial | Channel on Account; team/SLA later |
| [Import](features/import.md) | planned | CSV / paste; consent required |

Status: **shipped** = API + a UI on `/host/crm`. **Partial** = runtime exists,
Engage product UI does not. **Planned** = not in Go yet.

## How to use these specs

Each feature file is the source of truth for that slice. It names:

1. Who it is for and what done looks like.
2. What already exists (paths, tables, routes).
3. What to build.
4. Rules the server must enforce.
5. How it couples to Webinar Liv (or that it does not).
6. Calls, scale, and tests.

Do not implement against the mock HTML. Implement against these specs; the
mock is the look.
