# Engage — architecture and build spec

Engage is a **separate product** from Webinar Liv (own screens, own $149
plan, can run with zero webinars). It is **coupled** through a small event
and UI contract, not by merging the two apps. Same repo, same Cloud Run
Go API, same Postgres.

**Feature specs (source of truth per slice):** [`engage/README.md`](engage/README.md).  
**Product + coupling:** [`engage/PRODUCT.md`](engage/PRODUCT.md).  
**UI mock:** [`mockups/cursor/`](mockups/cursor/).

Phases 1–5 in [`WHATSAPP-CRM-PLAN.md`](WHATSAPP-CRM-PLAN.md) are **done**.
This file is topology, scale, call budget, and how the two workflow
engines run — not the per-feature spec.

Interactive diagrams (open the HTML):

- System: [`architecture/engage-system.html`](architecture/engage-system.html)
- Inbound message: [`architecture/engage-inbound.html`](architecture/engage-inbound.html)
- Build order: [`architecture/engage-phases.html`](architecture/engage-phases.html)

Sections 1–9 are the shape. The detail lives after them:

- §10 — scale: the numbers this deployment actually holds, and where it breaks
- §11 — call budget: what each screen is allowed to ask for
- §12 — the workflow engine and the journey builder

## 1. What we are building

**Engage** is the WhatsApp CRM: shared inbox, contacts, journeys, broadcasts,
templates, analytics, Connect WhatsApp. It is not a fork of WACRM, Whatomate,
Frappe CRM, or DeskcommCRM. It is not Webinar Liv; see
[`engage/PRODUCT.md`](engage/PRODUCT.md).

Hosts connect **their own** WhatsApp Business Account through Meta Embedded
Signup. Meta bills the host. The $149 Engage plan does not include conversation
fees.

## 2. Locked topology

Production already looks like [`DEPLOYMENT-TOPOLOGY.md`](DEPLOYMENT-TOPOLOGY.md):

| Piece | Runs where | Role |
| --- | --- | --- |
| Engage / host portal | Next.js 16 on **Cloudflare Workers** (`webinarliv.com`) | UI only |
| Product API | **Go** on **Cloud Run** `webcast-api` (`asia-south1`) | All CRM and WhatsApp logic, outbox sweeper |
| Database | **Supabase Postgres** `webcast-in` (`ap-south-1`) | Durable CRM + webinar rows; `pgx` from Cloud Run |
| Login | **Supabase Auth** | Google OAuth PKCE → `POST /api/auth/supabase` → `webcast_session` |
| WhatsApp | **Meta Cloud API** | Send + webhooks; host WABA token on `users` |

### 2.1 What “we have Go and Supabase” means

They are not two competing app servers.

- **Cloud Run Go** is the backend. Handlers in `api/internal/api`, Graph in
  `api/internal/wa`, SQL in `api/internal/store`. The sweeper that flushes the
  outbox and advances drips/bots runs **in this process**.
- **Supabase** is:
  1. **Postgres** (session pooler `:5432`) — the only CRM database.
  2. **Auth** for Google sign-in. After exchange, the browser holds
     `webcast_session` on the API origin. CRM reads do **not** use the Supabase
     JS client, PostgREST, or Realtime.

WACRM’s pattern (Next.js route handlers + Supabase RLS as the app) is **not**
ours. Do not add `supabase.from('crm_contacts')` in the frontend.

Cloud Run pool size is already sized to Supabase’s session-pooler cap
(`api/internal/store/store.go`). New CRM queries must stay short indexed
lookups. Do not add a chatty Realtime fan-out that opens extra clients.

### 2.2 Explicit non-goals

- No Baileys, WAHA, WhatsApp Web QR, or unofficial engines (Deskcomm default).
- No Whatomate / Frappe process beside Cloud Run (AGPL + second WhatsApp brain).
- No Next.js port of WACRM.
- No Webcast-paid Meta conversation fees.
- No new org table in v1 — still `host_id` (= `users.id`). Team agents (Phase 9)
  are rows *under* a host, not a second tenancy model.

## 3. What already exists (do not rebuild)

**Connect:** Embedded Signup, token on `users`, register PIN, webhook verify +
HMAC, ingest by `phone_number_id`.

**CRM data:** `crm_contacts`, `crm_messages` (thread = host+contact, no
`crm_conversations` yet), `crm_templates`, reminder templates, broadcasts,
drips, bots, tags, notes.

**API (host cookie):** `/api/host/whatsapp/*`, `/api/host/crm/contacts`,
thread + send + opt-out, templates, reminders, audience, broadcasts, drips,
bots, tags, notes, setup checklist.

**UI:** `/host/crm` — contacts + inbox panes, broadcasts, drips, bots, tags,
notes, template send with 24h rules enforced on the server.

**Outbox:** WhatsApp confirm / 24h / 1h / replay via `notifications` + sweeper.

The gap is product: the Engage shell, a real shared inbox, pipelines, team,
campaign wizard, journey canvas, conversation analytics. The Graph and ingest
paths are not the gap.

## 4. Frontend architecture

Keep the host portal on Cloudflare. Expand CRM into an Engage app **inside**
the same Next.js tree. Do not start a second frontend repo.

### 4.1 Information architecture

Mock source of truth: `docs/mockups/cursor/` (`assets/app.css`, `shell.js`).

| Route (proposed) | Mock | Backing API today |
| --- | --- | --- |
| `/host/engage` | dashboard | compose from setup + counts + open threads |
| `/host/engage/inbox` | inbox + session-closed | `GET contacts`, `GET contacts/{id}`, `POST …/send` |
| `/host/engage/contacts` | contacts 360 | contacts + tags + notes + thread |
| `/host/engage/journeys` | journeys / builder | drips (+ canvas later) |
| `/host/engage/campaigns` | campaigns + wizard | broadcasts |
| `/host/engage/templates` | templates | `GET /crm/templates?refresh=1` |
| `/host/engage/analytics` | analytics | new read APIs (Phase 12) |
| `/host/engage/integrations` | field mapping | webinar registration fields; no new vendor |
| `/host/engage/settings` | team + SLA + channel | Account WhatsApp card; team in Phase 9 |

Keep `/host/crm` as a redirect to `/host/engage/inbox` so existing “View in CRM”
links do not die.

`web/lib/api.ts` stays the only browser→API client. Types live in
`web/lib/api-types.ts`. Session remains the API cookie; Engage pages are
`"use client"` like `crm-screen.tsx`.

### 4.2 UI rules (copy from the mock, not Stitch)

- One chrome: sidebar + topbar. Tokens from the mock (`app.css`), implemented
  in the existing `web/components/ui.tsx` / Tailwind — do not iframe the HTML
  mock.
- Inbox is three columns: queue, thread, contact context.
- 24h window **open**: free-text composer. **Closed**: template picker, not a
  disabled textarea.
- Broadcast create is a **five-step wizard** (audience → template → variables →
  schedule → queued).
- Webinar field mapping is hidden until the host opens it.
- Automated sends in the thread name the drip/broadcast/bot that sent them
  (already on messages; surface it).

### 4.3 Realtime

v1: keep polling an open inbox (already in `crm-screen.tsx`) while the tab is
visible. Do **not** turn on Supabase Realtime for `crm_messages`.

If polling is not enough later: `LISTEN/NOTIFY` from Postgres through the Go
API (SSE or websocket **on Cloud Run**), still not PostgREST.

## 5. Backend architecture

One binary, one Cloud Run service.

```
Host / Meta
    → Cloud Run (Chi)
         → pgx → Supabase Postgres
         → Graph (host token) → host WABA
    ← Meta webhook (HMAC)
Sweeper (same process): notifications + drips + bots
```

### 5.1 Packages

| Package | Owns |
| --- | --- |
| `api/internal/wa` | Embedded Signup, Graph send, webhook parse, HMAC |
| `api/internal/store` | All SQL. Handlers never see SQL |
| `api/internal/api` | HTTP, product rules (consent, window, template status) |
| `api/internal/api/sweeper.go` | Due WhatsApp + drip/bot ticks |
| `api/internal/auth` | Supabase JWT → local `users` row |
| `web/` | Engage UI |

New work adds store files and `/api/host/crm/...` routes. Do not add
`/api/v1` for WACRM compatibility unless a public integration needs it.

### 5.2 Product rules (unchanged)

Enforced in Go on every send, not in the browser:

1. Opt-out / STOP → no send.
2. Marketing/broadcast → `whatsapp_opt_in_at` required.
3. Free-form text only inside the 24h window from last **inbound**.
4. Outside the window → approved template only.
5. Inbound is not consent (`Weak` profile names do not overwrite registration names).
6. Always 200 on a valid webhook after signature check.

### 5.3 New data (Phases 7–9)

Still `host_id`. Migrations append to `api/internal/store/migrations/` **and**
stay compatible with `cmd/migrate`.

**Phase 7 — conversations (only if the inbox needs facts a thread cannot derive)**

Today one number per host ⇒ conversation = `(host, contact)`. Add
`crm_conversations` when you need assignment, SLA clock, unread, or a second
phone number. Columns:

- `id`, `host_id`, `contact_id`, `assignee_id` (nullable `users.id` or later agent)
- `status` (`open`, `waiting`, `closed`)
- `inbox_state` (`unassigned`, `mine`, `bot`, `snoozed`)
- `last_inbound_at`, `last_outbound_at`, `first_response_at`
- `unread_count`, `window_opens_at` (or keep deriving window from messages)

Until that table exists, assignment can live as columns on `crm_contacts`.
Prefer the conversation table once team inbox is real — the 1b comment already
said this.

**Phase 8 — pipeline**

- `crm_pipelines` / `crm_stages` (host-scoped, ordered)
- `crm_contacts.stage_id`, `crm_contacts.owner_id`
- Default pipeline seeded per host: e.g. New → Registered → Attended → Customer

Webinar events already exist: registration, attendance, no-show, ended. Stage
moves can be automatic (drip-like rules) or manual from the contact pane.

**Phase 9 — team (optional, after a solo inbox works)**

Co-hosts already exist for webinars. Reuse `users` linked to the host rather
than inventing orgs. `assignee_id` points at those users. SLA targets on
`crm_host_settings` (`first_response_minutes`).

Skip this phase if Engage v1 is host-only (current model). The mock’s “Priya
Iyer / workload” is then a later add.

### 5.4 APIs to add (incremental)

All host-scoped, same 404-for-other-host’s-id rule.

| Phase | Method | Path | Purpose |
| --- | --- | --- | --- |
| 6 | — | — | No new API if dashboard is a composition of `GET /crm/setup` + contacts counts |
| 7 | `GET` | `/api/host/crm/inbox` | Queue: filters unassigned/mine/bot, unread, window open/closed |
| 7 | `POST` | `/api/host/crm/conversations/{id}/assign` | Assignee |
| 7 | `POST` | `/api/host/crm/conversations/{id}/read` | Clear unread |
| 8 | `GET/PUT` | `/api/host/crm/pipelines` | Stages |
| 8 | `PATCH` | `/api/host/crm/contacts/{id}` | stage, owner |
| 10 | — | existing broadcasts | Wizard is UI; add throttle/quiet-hours fields if missing |
| 11 | `PUT` | `/api/host/crm/drips/{id}` | Persist canvas graph if you stop using linear steps |
| 12 | `GET` | `/api/host/crm/analytics/inbox` | SLA, by-agent, window mix |
| 12 | `GET` | `/api/host/crm/analytics/campaigns/{id}` | Funnel from broadcast stats |

Public Meta webhook stays `GET|POST /api/webhooks/whatsapp`.

### 5.5 Outbound path

Unchanged: handler or sweeper → store outbox row → Graph with host token →
`crm_messages` + status webhooks. Broadcasts already chunk via the sweeper’s
100-row tick. Campaign wizard “throttle / quiet hours” become columns the
sweeper already consults — do not put a Redis queue in front unless Meta
throughput forces it.

## 6. Frontend × backend map

| Engage screen | Reads | Writes |
| --- | --- | --- |
| Dashboard | setup, contact counts, open inbox slice, last broadcast | — |
| Inbox open | inbox list, thread, contact, tags, notes | send text, assign, pause bot |
| Inbox closed | same + templates | send template |
| Contacts | list + filters + stage | stage, tags, notes, opt-out |
| Journeys | drips | save drip, enroll |
| Campaigns | broadcasts, audience preview | create/cancel broadcast |
| Templates | templates | refresh from Meta |
| Analytics | new analytics GETs | — |
| Integrations | webinar + merge fields | mapping JSON on host settings |
| Settings | WhatsApp link, features, SLA | connect/disconnect, PIN register |

## 7. Phase-by-phase build

Each phase is shippable. Backend migrations go with the phase that needs them.
Code goes in `api/internal/engage` (handlers), `api/internal/engage/crmstore`
(SQL) and `web/engage` (screens); see [`engage/MODULES.md`](engage/MODULES.md).
Tests: `api/internal/api/crm_*_test.go` pattern (host isolation, 404 other
host). Frontend: Playwright only when a flow is user-visible; unit the send
rules in Go.

### Phase 6 — Engage shell (frontend-heavy)

**Goal:** One product chrome. Existing APIs behind new routes.

- Nav: Dashboard, Inbox, Contacts, Journeys, Campaigns, Templates, Analytics,
  Integrations, Settings.
- Redirect `/host/crm` → inbox.
- Dashboard: open conversations, setup checklist, last broadcast stats (from
  existing broadcast list).
- Do not wait on new tables.

**Done when:** a host can click every mock destination and hit a real (if
sparse) page, not a toast.

### Phase 7 — Shared inbox

**Goal:** The mock’s two inbox states, backed by a queue endpoint.

- `GET /crm/inbox` with filters and window flag derived from `LastInboundAt`.
- Composer: open vs closed (already partly in `crm-screen.tsx`) — split routes
  so session-closed is a first-class URL or state.
- Unread + “open conversation” count on the dashboard.
- Optional: `crm_conversations` if assignment is in this phase; otherwise
  unread on contact is enough.

**Done when:** 24h lock matches Meta; STOP still opts out; poll updates the
queue without a full page reload.

### Phase 8 — Pipeline and contact 360

**Goal:** Stage + owner on the contact pane (Profile / Messages / Activity).

- Migrations for pipelines/stages.
- Default stages; registration/attendance can move stage (feature-flagged).
- Contact page tabs from the mock.
- Kanban can wait — list + stage filter is enough.

**Done when:** a registrant shows as Registered without a manual edit, and the
host can drag or patch stage.

### Phase 9 — Team and SLA (skip if host-only)

**Goal:** Mock workload + first-response SLA.

- Assignee on conversation; inbox filters Mine / Unassigned.
- `crm_host_settings.first_response_minutes`.
- Dashboard workload cards.

**Done when:** two people on one host account can split the queue without
seeing other hosts’ data.

### Phase 10 — Campaign wizard

**Goal:** Five-step broadcast UI on existing broadcast APIs.

- Audience counts already exist (`GET /crm/audience`).
- Add schedule/throttle/quiet hours if the table lacks them.
- Campaigns list: last-broadcast funnel, **no** phone simulator (mock decision).

**Done when:** create broadcast is the wizard, not a single form, and cancel
still works.

### Phase 11 — Journey canvas

**Goal:** Plans A–C in [engage/PLANS.md](engage/PLANS.md). Visual graph on
the existing sweeper: branches, wait-until, free-form with template
fallback, draft/publish.

- Persistence: `published_graph` the walker already understands. Linear drip
  rows are the migration source, not a second runner.
- Do not invent a second sweeper.

**Done when:** a host can publish the registration blueprint from the mock
and a registration enrolls, branches, and sends on the sweeper tick.

### Phase 12 — Analytics and integrations

**Goal:** Conversation SLA + campaign funnel + webinar field mapping.

- Read-only SQL aggregates; no warehouse.
- Integrations page: map registration fields → WhatsApp template `{{n}}`
  (reveal on click).
- Settings: channel health from existing WhatsApp link.

**Done when:** analytics numbers match `crm_messages` / broadcast stats in a
test, not a dashboard screenshot.

### Phase 13 — Ops (parallel, not blocked on 12)

Already documented in `WHATSAPP-CRM-PLAN.md` / `META-HANDOVER.md`:

- Tech Provider + App Review for **customer** WABAs.
- Test forever on our own number without that.

## 8. Verification (every phase)

- Go: host isolation tests; webhook HMAC; send refused when opted out / window
  closed / unapproved template.
- Cloud Run + Supabase: migration applied by `cmd/migrate`; pooler does not
  need new connection modes.
- Browser: one happy path on staging with a real test WABA (connect → inbound
  → reply inside window → template outside window).
- Never verify WhatsApp by QR.

## 9. Suggested order of work

Phase 6 (shell) and Phase 7 (inbox API) can overlap: inbox API first if the
current `/host/crm` list is too weak for the mock queue. Pipeline (8) after
the queue is real. Wizard (10) anytime after audience APIs, independent of
team (9). Canvas (11) after hosts actually use drips from the new Journeys
list. Analytics (12) last so the metrics have rows.

Start with **Phase 6 + 7**. That is the difference between “we have WhatsApp”
and “we have a WhatsApp CRM.”

---

## 10. Scale

Every number below is from the deployed configuration, not a target.

### 10.1 What the box is today

| Limit | Value | Where |
| --- | --- | --- |
| Cloud Run instances | min 0, max 3 · 1Gi / 1 CPU | `deploy/cloudrun-deploy.sh` |
| Postgres conns per instance | 4 (`DB_MAX_CONNS`) | `store.go` |
| Supabase session pooler ceiling | 15 clients, whole project | `deploy/SUPABASE.md` |
| Sweeper tick | 30 s | `sweeper.go` |
| Email outbox per tick | 100 | `flushOutbox` |
| WhatsApp outbox per tick | 100 | `flushWhatsAppOutbox` |
| Drip steps per tick | 100 | `dripStepsPerSweep` |
| Bot sessions woken per tick | 50 | `botSessionsPerSweep` |
| Bot steps per conversation | 60 | `botNodesPerSession` |
| Contacts per page | 200 | `crmContactsPageMax` |
| Messages per thread read | 300 | `crmThreadMax` |
| Send retry | 5 attempts, backoff `30·2ⁿ` s capped at 900 s | `RecordSendAttempt` |

3 instances × 4 conns = 12 of the 15 pooler clients. **Raising
`--max-instances` without lowering `DB_MAX_CONNS` breaks boot**, which is the
failure this pool size was chosen after.

### 10.2 Outbound throughput

100 WhatsApp rows per 30 s = **200/min = 12,000/hour, for the whole
deployment**, not per host. The queue is `ORDER BY due_at, created_at` across
every host.

Consequences to design around:

- A 10,000-recipient broadcast takes **~50 minutes** to drain.
- While it drains, another host's `wa_reminder_1h` sits behind it. A one-hour
  reminder that arrives 50 minutes late is wrong.
- Meta is not the bottleneck. Cloud API does ~80 messages/second by default;
  per-WABA 24-hour caps (250 / 1k / 10k / 100k business-initiated, by tier)
  bind the **host**, not us.

So the sweeper's fairness, not Graph, is the first thing to fix as hosts are
added. Two options, cheapest first:

1. **Per-host quota per tick** — `ROW_NUMBER() OVER (PARTITION BY host_id)` in
   `PendingWhatsApp`, take the first N per host. One host can no longer own a
   tick. No new infrastructure.
2. **Priority column** — reminders and confirmations ahead of broadcast and
   drip rows at the same `due_at`. Transactional beats marketing.

Do (1) before the first host with more than ~2,000 contacts. Do (2) with it if
broadcasts and reminders ever share a busy hour.

### 10.3 Known defect: the sweeper is not single-writer

`StartMeetingLimitSweeper` is launched in `main.go` on **every** instance.
`PendingWhatsApp` is a plain `SELECT` and the row is only marked after the
Graph call returns. There is no `FOR UPDATE SKIP LOCKED` and no leader
election.

With `--max-instances 3`, two overlapping ticks can read the same 100 pending
rows and both send. That is a **duplicate paid WhatsApp message** on someone's
phone, and the same hazard exists for email.

It is latent today only because traffic rarely holds a second instance open —
a rollout is enough to hold two. Fix before Phase 10 (campaigns are when
volume arrives).

**Decision:** move the outbox, drips and bots onto **River** jobs (plan 0 in
[engage/PLANS.md](engage/PLANS.md)). River claims with `SKIP LOCKED`, rescues
stuck jobs, and retries with backoff, which covers the “claim the row” option
below without hand-written claim columns. The two options are kept for the
record:

- **Claim the row** (preferred): `SELECT … FOR UPDATE SKIP LOCKED` inside a
  transaction that flips `delivery` to `sending` before the Graph call.
  Requires a `sending` state and a stale-claim reaper for a crashed instance.
- **Advisory lock** per sweep: `pg_try_advisory_lock` so exactly one instance
  sweeps. Simpler, but serialises the whole sweep on one instance.

Drips are already safe: `QueueDripStep` moves the enrollment in the same
transaction guarded by `position`, so a race produces one message and one
`ErrConflict`. Bot sessions are guarded the same way. **The outbox is the
unguarded step.**

### 10.4 Broadcast creation

`CreateBroadcast` inserts one `notifications` row per recipient inside **one
transaction**. A 10,000-recipient broadcast is a 10,000-row insert holding a
transaction open while the host's browser waits.

Fine to a few thousand. Past that, either batch the insert
(`COPY` / multi-row `INSERT`) or store the audience predicate and materialise
recipients in the sweeper. Decide at Phase 10; don't rewrite it before.

### 10.5 Growth tiers

| Tier | Shape | What must change |
| --- | --- | --- |
| **Now** (1–20 hosts, <5k contacts each) | Current code | Nothing. Fix §10.3. |
| **100 hosts / 50k contacts / ~50k msgs per month** | Same box | Per-host quota (§10.2). Cursor pagination (§11.3). Index review on `crm_messages(contact_id, created_at DESC)`. |
| **1,000 hosts / millions of messages** | Workers separated | Run the same binary with `ROLE=worker` (River only, no HTTP) as its own process — a second Cloud Run service with min 1, or a second server — and `ROLE=api` for HTTP. River locking makes several workers safe. Partition `crm_messages` by month. Move to the transaction pooler and re-raise `DB_MAX_CONNS`. |

The sweeper split is the one architectural change on the horizon. Everything
before it is a query or an index.

### 10.6 Inbound capacity

Webhooks are cheap and bounded by Meta: parse, one contact upsert, one message
insert, return 200. The bot runtime is the exception — it replies **inline on
the webhook request** so the person holding the phone is not waiting on a
30-second tick. That puts a Graph round trip inside the webhook handler, which
is why the step budget (60) and the node cap exist.

If webhook latency ever approaches Meta's timeout, move the bot reply to a
queue and accept the delay. Do not remove the budget.

---

## 11. Call budget

The rule: **one screen, one round of calls.** A screen that needs five
sequential requests to paint is a bug, not a loading state.

### 11.1 Per screen

| Screen | Calls on open | Repeat | Notes |
| --- | --- | --- | --- |
| Dashboard | 1 (`GET /crm/overview`, new) | none | Compose server-side. Do not assemble from 4 list calls. |
| Inbox | 2 (`GET /crm/inbox`, then thread on select) | queue every 20 s while visible | Thread only on selection. |
| Thread | 1 | 20 s with the queue | Capped at 300 messages. |
| Contacts | 1 (list + counts in one response) | none | Search debounced; first load is not. |
| Templates | 1 cached read | never automatic | `?refresh=1` is a host button — it spends a Graph rate limit. |
| Campaigns | 1 list | none | Stats are already subselects in `broadcastSelect`. |
| Journeys | 1 list | none | Steps and stats come with the list. |
| Analytics | 1 per panel, max 2 | none | Aggregates server-side, never in the browser. |

`GET /crm/contacts` already returns counts + last message + last inbound in
**two** queries using `LEFT JOIN LATERAL`. Keep that pattern for the inbox
queue: no N+1, no per-row follow-up.

### 11.2 Polling

Today: 20 s, only when `document.visibilityState === "visible"`. Keep it.

Cost at 20 s: 3 requests/min per open tab. 200 concurrent tabs = 10 rps =
~20 queries/s across 12 connections. That is comfortable. 2,000 tabs is not,
and that is the trigger for:

1. **Conditional GET** — `ETag` on the queue response from
   `max(updated_at), count(*)`; unchanged queue returns `304` and touches no
   rows.
2. Only then SSE from Cloud Run over `LISTEN/NOTIFY`.

Never Supabase Realtime for CRM rows: it opens connections outside the pool
accounting in §10.1 and puts row-level auth in a second place.

### 11.3 Pagination

Contacts cap at 200 per page with no cursor today — the list is
`ORDER BY coalesce(last_seen_at, created_at) DESC, id DESC`, so add a
**keyset cursor** on that exact pair when a host passes ~200 contacts.
Do not add `OFFSET`; it re-reads the prefix on every page and the sort key is
already unique with `id`.

### 11.4 Payload discipline

- Never send `access_token`, `verify_token`, or the 2FA PIN. They are stored
  encrypted-at-rest and never returned. Ever.
- Send display fields the list needs (`tagName`, `webinarTopic`) **with** the
  row — that convention already exists on `CRMBroadcast`/`CRMDrip` precisely to
  avoid a second request. Keep it.
- Lists return `[]`, never `null`.
- A contact id from another host is `404`, not `403` — the existing rule.

### 11.5 Writes

| Action | Call | Guard |
| --- | --- | --- |
| Send free text | `POST /crm/contacts/{id}/send` | Server re-checks 24 h window and opt-out |
| Send template | same | Template must be approved and param count must match |
| Assign / read | `POST …/assign`, `…/read` | Phase 7 |
| Stage change | `PATCH /crm/contacts/{id}` | Phase 8 — one PATCH, not a PUT of the contact |
| Create broadcast | `POST /crm/broadcasts` | One call for the whole wizard; steps 1–4 are client state |

The wizard must not write per step. Audience counts (`GET /crm/audience`) are
reads; the broadcast is created once, at the end.

---

## 12. Workflow: engine and builder

The product workflow is **one journey graph**. Tech and the full mock are
[engage/PLANS.md](engage/PLANS.md). Short version:

- **Walker:** our Go graph interpreter, run as **River** jobs (Postgres job queue, in-process, `pgx`). River gives scheduled jobs, retries, uniqueness and `SKIP LOCKED` claiming across instances. Needs an always-on process: Cloud Run `--min-instances 1 --no-cpu-throttling` today, or a dedicated server (planned option; see Hosting in PLANS.md). No GCP-only services in the job path. Plan 0. Not Temporal, Inngest, Redis, or n8n.
- **State:** Postgres. `draft_graph` / `published_graph` jsonb. Enrollment pointer + `next_due_at`.
- **Sends:** approved template → existing `notifications` outbox. Free-form body and quick replies → existing session send, only while the 24 h window is open; otherwise that same step’s template fallback.
- **Canvas:** `@xyflow/react` in the Next app. Coordinates are not runtime state.
- **Branches:** Go predicates (attribute, operator, value, AND).

Drip steps and bot nodes already in Go are the linear and inbound subsets of
that graph. Phase 11 replaces the linear editor; it does not add a runner.

### 12.1 What is already running

These two tables are the code today. They fold into the one graph above;
they are not the product split.

| | **Drips** (sequences) | **Bots** (flows) |
| --- | --- | --- |
| Starts from | An event: `registered`, `attended`, `no_show`, `ended`, `tag_added`, `manual` | An inbound message: any message, or keywords |
| Clock | Wall clock, minutes to days | The conversation, seconds |
| Sends via | The **outbox** — queued, swept, retried | **Inline** on the webhook request |
| Message type | Templates today; free-form body is plan B, with this row’s template as the closed-window fallback | Host's own words while the window is open |
| Advanced by | `AdvanceDrips` each tick | The inbound webhook, plus `AdvanceBots` for `wait` nodes |
| State | `crm_drip_enrollments` (position, `next_due_at`) | `crm_bot_sessions` (node key, state, steps) |

A step due in three days is usually outside the service window, so the
walker sends that step’s **template**. The same step may also carry a
free-form body, sent only when the window is open. One graph, two send
paths. Phase 11 does not add a second engine.

### 12.2 Node model (bots, today)

Five kinds, one struct, `Key` is identity and every edge is a key:

| Kind | Does | Fields |
| --- | --- | --- |
| `message` | Says something, moves on | `text`, `next` |
| `ask` | Asks with ≤3 reply buttons (Meta's cap) | `text`, `buttons[]`, `next` = fallback |
| `wait` | Pauses, ≤24 h (the window closes after) | `delayMinutes`, `next` |
| `enroll` | Puts them on a drip | `dripId`, `next` |
| `set_tag` | Applies a tag | `tagId`, `next` |
| `handoff` | Stops the bot, gives the thread to a person | `text` |

Drip steps are simpler: ordered `delayMinutes` + template + params, delay
measured **from the previous step** so inserting one doesn't move the rest.

### 12.3 Guards (why it can't run away)

These exist and must survive the canvas:

- **Cycle-free** — the whole graph is validated on save; every `next` must
  name a node that exists. Validating needs all nodes at once, which is why a
  save replaces the flow rather than patching a node.
- **Step budget** — 60 nodes per conversation. Every step that speaks costs
  the host money.
- **Window** — a session asleep past 24 h ends `window_closed`, not a failed
  send.
- **Missing node** — a host who edits a live flow can orphan a parked
  conversation. Runtime reads that as `node_missing` and stops with a reason.
- **Human override** — `bot_paused_at` is on the **contact**, not the session,
  so taking a conversation over holds for their next message too.
- **Idempotency** — the last `wamid` acted on is stored; a Meta redelivery
  does not re-run a step.
- **Exit** — opt-out or STOP exits every active enrollment and skips its
  pending outbox rows in one place (`exitDripsForContact`).

### 12.4 Builder contract (Phase 11)

The canvas is a **new editor for the same payload**. Non-negotiable:

1. **Save is whole-graph.** `PUT /crm/bots/{id}` and `/crm/drips/{id}` already
   replace nodes/steps in one transaction. The canvas sends the same request.
   No per-node autosave endpoint — it would let a half-saved graph run.
2. **Keys are identity.** Renaming a node rewrites its edges. The builder
   generates keys; contacts never see them.
3. **Position is presentation.** If the canvas stores x/y, it goes in a
   nullable layout column (or a `layout` JSON blob on the bot), and the
   runtime never reads it. The current list editor deliberately stores no
   coordinates; adding them must not become a runtime dependency.
4. **Validation happens twice.** The canvas shows a broken edge immediately;
   the server refuses the save anyway.
5. **Live edits are expected.** A running flow is the normal case. The editor
   must say how many sessions are parked on a node before it is deleted —
   `BotSessions` already exposes that.

### 12.5 Journeys screen (Phase 11 scope)

The list, canvas, branch editor, and create dialog in the mock. Spec:
[engage/features/journeys.md](engage/features/journeys.md).

- Stats already exist: `CRMDripStats` and `CRMBotStats`. Goal conversion is
  plan A, counted from the goal the host set on the journey.
- `EndedReason` belongs on the canvas node (how many people stopped here),
  not only in a table.

### 12.6 Workflow scale

- A drip with 1,000 people whose steps all come due at once drains at 100 per
  tick = **5 minutes**, then hits the shared 200/min outbox ceiling (§10.2).
- A bot `wait` node with 1,000 parked sessions wakes 50 per tick =
  **10 minutes**. Both are deliberate: the alternative is a thousand messages
  in one second.
- Steps are queued **as they come due**, never all at enrollment, so a paused
  or edited sequence stops immediately rather than draining a pre-built queue.
- Delay is counted from **now**, not from when the step was due, so a sequence
  that fell behind does not fire its remaining steps back to back.

Keep all four properties in Phase 11. They are the reason a misconfigured
journey costs a host a slow trickle instead of a bill.
