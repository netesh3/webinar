# Engage plans

> **Parked (Sep 26 2026).** First version is [V1.md](V1.md): webinar reminders
> and post-webinar follow-up only. This document is the long-term target.

Every control on both mock sets is a goal:

- `docs/mockups/cursor/screens/` — 17 screens (the design system).
- `docs/mockups/engage/screens/` — adds WhatsApp hub, flow builder, execution
  logs, database & webhooks, attendance.

Plans are shippable slices of that set. A plan may land after another; none is
optional.

Hard constraints (not missing screens): official Cloud API only, on the host’s
own WABA; Meta bills that WABA; no second database, no second Cloud Run
service, no Redis. The engage mock’s “Postgres 16 + Redis broker” caption is
decoration, not a decision.

## Validation against the code (Sep 26 2026)

What the first draft got wrong, and what is true today:

| Draft said | Code says | Fix |
| --- | --- | --- |
| The tick already uses `SKIP LOCKED` | No `SKIP LOCKED` anywhere. `PendingWhatsApp` and `DueDripSteps` are plain `SELECT … LIMIT` | Plan 0 adds claim-then-send |
| The sweeper just runs | It is a goroutine in `StartMeetingLimitSweeper`. Cloud Run is `--min-instances 0` with request-based CPU, so an idle service has no tick. A step due at 3 AM does not fire | Plan 0: River workers on an always-on process (Cloud Run min 1, or a dedicated server) |
| One sweeper | Up to 3 instances each run it (`--max-instances 3`). Drips survive through the `position` guard; the outbox does not — two instances can send one row | Plan 0: River claims jobs with `SKIP LOCKED` |
| “Stream ended” is a new trigger | `ended`, `attended`, `no_show` already exist on drips | Plan C adds watch minutes to them, not a new trigger |
| Branch on “already in the VIP community” | Cloud API cannot see who joined a WhatsApp group or community | A contact attribute set by tag, import, a button reply, or the host. Plan A names it so |
| Quiet hours in the contact’s timezone | `crm_contacts` has no timezone | Plan A derives it from the E.164 country code, host timezone as fallback |
| Watch minutes are available | They are: `attendance_visits` (per visit) → `attendance.registration_id` → contact by registration phone/email | Plan C sums visits at webinar end |
| Repeat / re-entry | `crm_drip_one_per_contact` allows one enrollment per contact per journey, ever | Plan A adds a re-entry policy |
| Opt-out keyword list is editable | `isWhatsAppStop` hard-codes STOP, UNSUBSCRIBE, STOP ALL, OPT OUT, OPTOUT. The mock adds CANCEL and QUIT | Plan I: host list on top of the built-ins, never below them |
| Template status by webhook | Only `messages` statuses are handled. `message_template_status_update` and `phone_number_quality_update` are not | Plan H |
| Templates with a CTA link send | `send.go` marks a template unsendable when a button has a variable | Plan H: URL-button params, needed for tracked links |
| Link CTR | No click tracking exists | Plan H: redirect links |
| Two sender numbers | One number per host, columns on `users`. `crm_messages` has no channel | Plan K |
| Marketing vs utility opt-in | One `whatsapp_opt_in_at` | Plan G: separate marketing consent |
| Attributed revenue, “purchased” stop | No purchase data | Plan L: conversion events API |
| $149 plan | No billing code | Plan J |
| Engage reads polls/Q&A/chat for attendance tiers | PRODUCT.md forbids reading them directly | Webinar Liv publishes a per-registration summary at webinar end (plan C) |

## Workflow tech (all journey plans)

| Piece | Tech | Why |
| --- | --- | --- |
| API and walker | Go, inside `webcast-api` on Cloud Run | Same binary that already sends WhatsApp |
| State | Postgres (Supabase): graph, enrollments, outbox, events | Same database as contacts and `notifications` |
| Clock and jobs | **River** (`riverqueue/river`, Go, jobs in Postgres) running in-process on `pgx`. Needs an always-on process: Cloud Run `--min-instances 1 --no-cpu-throttling`, or a dedicated server | Timers, retries, uniqueness, locking (`SKIP LOCKED` inside River), cron, stuck-job rescue. Fixes the double-send across instances. Host-agnostic |
| Journey interpreter | Our Go code, run by River jobs | Graph walking, window rule, Meta rules. River does not know what a journey is |
| Template sends | `notifications` outbox → Graph with the host token | Retries, quiet hours, throttle, tier cap |
| Session sends | `wa.SendText` / `wa.SendButtons` (already written) | Free-form and reply buttons, window open only |
| Canvas | `@xyflow/react` (to install) under `/host/engage` in the Next app on Workers | Client-side only. x/y is presentation |
| Branch rules | Go predicates: attribute, operator, value, AND / OR groups | The branch-rules screen. Not CEL |
| Draft vs live | `draft_graph`, `published_graph`, `version`, `published_by`, `published_at` | “Last published … by Ganesh” |
| Schedules | River periodic jobs for fixed intervals; per-journey cron strings parsed with `robfig/cron/v3` and inserted as scheduled River jobs | No external scheduler per journey |

Not the engine: Temporal, Inngest, Restate, BullMQ, Redis, n8n, Zapier. River is the job queue, not a workflow engine; the graph interpreter is ours.

### How River is used

| Job | Enqueued when | Does |
| --- | --- | --- |
| `journey.step` `{enrollment_id, node_key, version}` | Enroll, or after the previous node, with `ScheduledAt` = the wait | Runs one node, enqueues the next. Unique by (enrollment, node) so a retry cannot double-advance |
| `wa.send` `{notification_id}` | A template or session message is due | One Graph call; River retry with backoff; Meta 4xx that won’t change → cancel, not retry |
| `wa.status_batch` | Webhook buffers ~1 s of statuses | One bulk `UPDATE … FROM unnest` |
| `journey.schedule` | River periodic job each minute | Fires journeys whose cron is due |
| `crm.import` | Large CSV | Background import with progress |
| `analytics.rollup` | Periodic, hourly | Daily rollup table |

- Queues and limits: `wa_send` queue with ~20 workers per instance, plus a per-sender-number limiter (≈50 msg/s) in the worker; `journeys`, `default` queues separately so a campaign cannot starve steps.
- Fairness: campaigns enqueue in slices per host (e.g. 500 at a time) rather than 50k jobs at once; priority 1 reminders, 2 journeys, 3 campaigns.
- Insert in the same transaction as the business write (`InsertTx`), so an enrollment and its first job commit or roll back together.
- Pause / edit: the `journey.step` job re-reads the enrollment and graph version when it runs; a paused journey snoozes, a stale node exits `node_missing`.
- Migrations: River’s tables via `rivermigrate` in `cmd/migrate`, alongside ours.
- UI: River UI behind admin auth for ops (optional).
- Spike first: confirm River’s `LISTEN/NOTIFY` and advisory usage on the Supabase session pooler (port 5432). If notify is unreliable there, River falls back to polling, which is fine.

## Hosting: Cloud Run today, a dedicated server possibly soon

We may move `webcast-api` off Cloud Run to a cheaper always-on box (Hetzner / OVH / a VPS, Docker + Caddy). Every plan must work on both. Rules:

- **One process, one container.** HTTP server and River workers in the same Go binary, as today. On a VPS that is one systemd unit or `docker compose` service; on Cloud Run it is the service with `--min-instances 1 --no-cpu-throttling`.
- **No GCP-only runtime dependency.** No Cloud Scheduler, Cloud Tasks, Pub/Sub, or Cloud Run Jobs in the send or journey path. Schedules are River periodic jobs. Logs go to stdout as JSON (Cloud Logging reads it; on a VPS, Loki / Grafana or plain files).
- **Postgres stays Supabase** (or any Postgres 15+). River only needs Postgres, not the host.
- **Config by env only** (already). Secrets from env / a file, not Secret Manager API calls.
- **Graceful shutdown** (SIGTERM, already in `main.go`) must also stop River with a timeout, so a deploy does not cut a Graph call in half. River re-runs an interrupted job; `wa.send` is safe because the wamid is recorded before the thread write.
- **TLS and webhooks:** Meta and Stripe webhooks need a stable HTTPS URL. On a VPS: Caddy with automatic certificates, same hostname (`api.webinarliv.com`), so moving hosts is a DNS change.
- **Scaling on a box:** vertical first (a 4 vCPU / 8 GB box is ~€15–30/month and outruns 3 × Cloud Run 1 vCPU). A second box can run the same binary; River’s locking already makes two workers safe. Put `DB_MAX_CONNS` in env so a bigger box can take more of the pool.
- **Health:** `/healthz` for the load balancer or uptime check; River queue depth and oldest-job age on an admin endpoint so a stuck worker is visible without GCP.
- **What changes on the move:** `deploy/cloudrun-deploy.sh` → a `docker compose` file and a deploy script; GitHub secrets feed an env file on the box. Nothing in `api/` changes.


Meta accepts free-form text and interactive buttons only inside the 24-hour
customer service window, opened by the contact’s last inbound message. Every
message step picks at send time:

1. Window open → send the body (and buttons).
2. Window closed, step has an approved template → queue that template. The
   Settings switch **24-hour session fallback** (`engage_utility_reopen`) is
   the host default when the step names none.
3. Window closed, no template → park until they write in, up to the step’s
   max wait, then exit `needs_template`.

A template with quick-reply buttons is the legal way to ask a question outside
the window: the tap is an inbound message, opens the window, and advances a
`wait_reply` node (plan B).

Pricing note for copy: Meta has billed per delivered template message since
July 2025, not per conversation. Utility templates sent inside an open window
are free. Settings and campaign copy must say “per message”.

## Plans

### 0 — Runtime foundations (before any new journey feature)

- Add River (`riverqueue/river`, `riverpgxv5`) and its migrations. Move `flushWhatsAppOutbox`, `AdvanceDrips`, `AdvanceBots` onto River jobs; delete the 30 s ticker’s CRM part once each is moved.
- Always-on process: Cloud Run `--min-instances 1 --no-cpu-throttling` now, or the dedicated server (see Hosting). No Cloud Scheduler tick.
- River stops inside the existing SIGTERM shutdown, with a timeout.
- Locking, claim expiry and retries come from River. No hand-written `claimed_by` columns.
- Per-host send quota per tick and priority (reminder 1h > journey > campaign), so one broadcast cannot starve a reminder.
- Tier cap: read `messaging_limit_tier` from Graph on connect and daily; stop business-initiated sends at the tier (Tier 1 = 1,000 unique contacts / 24 h) with reason `tier_limit`.
- Meta error 131049 (marketing frequency cap per user) → skip, not retry.
- Execution log row per send attempt (plan H “Execution logs” reads it).

### A — Journey graph (cursor: journeys, create-journey, both builders, branch rules; engage: flow builder)

- List: trigger, steps, enrolled, delivered, active / paused / draft, search, trigger filter, goal conversion, reply rate.
- Canvas: trigger, template message, session message, quick replies, if/else, wait, insert between nodes, converge, zoom/fit.
- Branch editor: attribute, operator (`=`, `≠`, set, not set, `>`, `<`, contains), value, AND / OR, true/false targets, “test the condition” on a real contact with no send, evaluations and split counts per node.
- Attributes: built-in (opt-in, stage, tags, source, watch minutes, attendance %, attendance tier, registered webinar) and **custom fields** (`crm_fields` definitions + `crm_contacts.attributes jsonb`). “VIP community member” and “community tier” are custom fields.
- Wait: delay, wait-until an absolute time, wait-until relative to webinar start (recomputed when the webinar moves), wait-until a contact date field.
- Inspector: template, category, language, variables → contact / event / attendance / custom fields with fallbacks, preview, test send to the host’s number, sends so far, delivery %.
- Draft / publish (show live enrollment count) / pause. Enrollment stores the graph version; a deleted node ends its people `node_missing` after the editor shows the count.
- Stop conditions: opt-out keyword, block (Meta error 131026/131047 or user-blocked status), a named tag or stage, a conversion event (plan L).
- Quiet hours: host default 22:00–08:00, contact timezone from the phone prefix (host timezone for multi-zone countries); due steps slide to the next allowed minute.
- Human reply pauses that contact’s automations for 24 h (`automation_paused_until` on the contact, alongside `bot_paused_at`).
- Re-entry: once ever (today), once per webinar, or after N days.
- Repeat: wait loops need a cap; publish rejects an uncapped cycle.
- Goal per journey: stage reached, tag added, link clicked, or conversion event, within N days. Conversion is counted from events.
- Blueprints (5 on the dialog): registration onboarding, 2-stage countdown, post-webinar attendance split, lead welcome + resource, VIP calendar reminder. Seeded as draft graphs with placeholder templates the host must map.
- Simulate: run a sample contact through the graph with no sends (“Quick test simulation”, “Test journey”).
- Limits: 100 nodes per graph, 60 steps per enrollment, delay ≤ 90 days.
- Migration: existing `crm_drips` become linear graphs; existing bots become graphs with an inbound trigger. Old endpoints stay until the UI moves.

### B — Session and reply steps

- Session message: body, optional ≤3 reply buttons (≤20 chars each), optional template fallback.
- `wait_reply`: waits for an inbound message or button tap, branches on which button / keyword / any reply, with a timeout branch.
- Inbound routing order: STOP → human takeover → a `wait_reply` enrollment for this contact → bot keyword trigger → catch-all. One inbound advances one thing.
- Session sends run inline on the tick, not through the template outbox, but write the same execution log.

### C — Triggers and webinar data

Already in Go: `manual`, `registered`, `attended`, `no_show`, `ended`, `tag_added`. Add:

- Contact added (import, single add, form, API), with source filter.
- Field changed (stage, custom field).
- Inbound message / keyword (the bot trigger, on the graph).
- Inbound webhook (plan I endpoint).
- Schedule: one-shot time or cron, with an audience (segment) to enroll.
- Date field: N days before/after a contact date (booking, renewal).
- Conversion event received (plan L).
- Webinar end summary per registration, written by Webinar Liv, read by Engage: watch minutes (sum of `attendance_visits`), attendance % of session length, joined/left, chat / question / poll counts. Tier = High / Med / Low / No-show with host thresholds (engage attendance mock: >75 %, 40–74 %, <40 %, 0). Available to conditions and templates.
- Recording published → enroll trigger (today it only queues `wa_replay`).

### D — Inbox (cursor: inbox, inbox-session-closed; engage: WhatsApp hub)

- Queue filters: all, needs reply, bot handled, resolved, mine, unassigned. Unread, owner, window time left, source.
- `crm_conversations` table becomes necessary here: open / resolved state, assignee, first-response and resolve timestamps. Today a thread is derived from `(host, contact)`.
- Assign, resolve, reopen on the next inbound.
- Thread shows automation lines with journey / campaign name.
- Composer: reply, saved replies (host-managed list), private note, attach image / document (Cloud API media upload), emoji.
- Inbound media: store the Meta media id, fetch on open through the API (media URLs expire), show images and documents instead of “sent an image”.
- Window closed: template picker + variables + preview + send.
- Tag, stage, pause bot/journey from the thread.
- Hub extras: quick-action buttons (“Send replay link”, “Send community URL”) = saved replies with variables; community invite link with copy / QR / share.
- Updates: polling every 10 s on the open tab, `?since=` cursor. No Supabase realtime (the pool and RLS are not set up for it).

### E — Team and SLA

- Members: owner, admin, agent, read-only. Invite by email, accept, remove. Agent scope: assigned only, or assigned + unassigned.
- Every CRM handler resolves `host_id` from membership, not `user.ID`. This touches every `/crm/*` route; isolation tests per route.
- First-reply SLA and resolve SLA; business hours for the clock; bot and automation messages do not stop it.
- Assignment: leave unassigned, always one member, or round-robin among online agents.
- Audit log: who sent, assigned, exported, changed settings (settings mock lists it).
- Dashboard workload and analytics inbox-by-agent with breaches.

### F — Campaigns

- Five steps: audience → template → variables, fallbacks, test send, device preview → schedule, throttle, quiet hours → queued. One POST.
- Audience: opted in, webinar registrants, tag, saved segment (any attribute filter from plan A), CSV of E.164.
- Marketing templates only for marketing-consented contacts. Show estimated Meta cost (per delivered message, by country) before send.
- Tier cap respected: a 5,000 audience on Tier 1 is split across days, and the wizard says so.
- Cancel until drained. Clone a campaign. Stats funnel incl. clicks and replies.

### G — Contacts, consent, pipeline, import

- List, search, filters (stage, tag, source, webinar, opt-in, custom field), owner, bulk tag / stage / enroll / export.
- Contact page: fields, custom fields, tags, notes, journeys on, messages, webinar history, timeline of events.
- Consent: `whatsapp_opt_in_at` (utility) plus `marketing_opt_in_at`, each with source and evidence text. Opt-out clears both.
- Pipeline: one pipeline, five mock stages, renameable; auto-move from webinar events if on, never backwards.
- Import: CSV / XLSX upload, column mapping with auto-match, E.164 normalise with a default country, tags on commit, duplicate policy (update, skip, second record), enroll or not, consent checkbox, preview of the first 20 rows, single contact form.
- Large files: over 5,000 rows run as a background job on the tick with progress, not one HTTP request.
- Opt-in verification: a template with a “Yes” button; the tap sets consent.
- Delete contact and data export per contact (privacy request).

### H — Templates, dashboard, analytics, logs

- Templates: list, status, category, quality, inspector, preview, create from Engage (`POST /{waba}/message_templates`, header / body / footer / buttons, samples), edit re-submits, delete. Status and category changes from the `message_template_status_update` webhook, not only manual sync.
- URL buttons with a variable and media headers become sendable (params for header and button components).
- Link tracking: `/l/{code}` redirect on our domain, per send, records click then 302. Used for CTR and goal “link clicked”.
- Dashboard: one `GET /crm/overview` — channel quality and tier, delivery volume, open queue, workload, active journeys, setup checklist.
- Analytics (7 / 30 / quarter / YTD, audience filter): sent, delivered, read, CTR, replies, show-up rate, show-up by channel (WhatsApp vs email reminder), attributed revenue, velocity chart, inbox by agent, top automations with goal and conversion, CSV export of aggregates. Daily rollup table if live queries pass 300 ms.
- Execution logs (engage mock): every send attempt with status, latency, error, template, journey; filters; “duplicate suppressed” rows; resend a failed message; export.
- Attendance (engage mock): per webinar, tier counts, attendee table with join/leave, duration, pre-event WhatsApp state, follow-up state, conversion; recalculate tiers; commit segmentation = enroll each tier in its journey.

### I — Integrations, API, settings (cursor: integrations, settings, settings-channels; engage: database & webhooks)

- Field mapping (8 mock rows incl. `Attendance.watch_minutes`), test payload, save.
- Inbound webhook: per-host endpoint with secret, HMAC-SHA256 header, JSON path → contact fields, idempotency key header, event log with replay, test event.
- Outbound webhooks: host URL receives message.received, message.status, contact.created, journey.completed, conversion; signed, retried from the outbox.
- Public API: API keys per host (hashed, scoped), `POST /v1/contacts`, `POST /v1/events`, `POST /v1/journeys/{id}/enroll`, `POST /v1/messages`. Postman collection export (engage mock).
- Google Sheets: OAuth (Webinar Liv GCP project), poll a sheet every tick for new rows → contact + optional journey.
- Google Calendar: OAuth, booking created → contact date field → VIP reminder blueprint.
- HubSpot: OAuth app, contact + stage sync both ways, stage change → enroll.
- Zapier: a Zapier app on our public API (triggers from outbound webhooks, actions from `/v1`). Publishing needs Zapier review.
- Settings: workspace profile, timezone, currency; opt-out keywords (built-ins locked); dispatch throttle; session fallback template; quiet hours; hash phones in logs after 90 days (a daily job); data retention; audit log; webhook re-verify; channel health.
- WhatsApp profile: about, description, photo, website (Graph `whatsapp_business_profile`).

### J — Billing and plan

- Stripe checkout for Engage Growth Pro $149/month; customer portal; webhook sets `engage_plan`, `engage_status`, `current_period_end`.
- Gate `/host/engage` and Engage sends on an active plan or trial; Webinar Liv keeps working without it.
- Usage meters shown in settings: contacts, inbound webhook events (mock: 31,480 / 50,000), seats.
- Plan copy: $149 is software; Meta bills the host’s WABA per delivered template.

### K — Multiple sender numbers

- `crm_channels` (host, WABA, phone number id, token, display, quality, tier). Move the `users.whatsapp_*` columns there; keep a view for the old code during migration.
- `channel_id` on contacts’ threads, messages, outbox rows, campaigns, journeys (“Sender” select on the create dialog).
- Webhook routes by `phone_number_id` to the channel.

### L — Conversions and revenue

- `crm_events` (host, contact, name, value, currency, occurred_at, source, idempotency key).
- Sources: public API, inbound webhook, Stripe payment link / checkout of the host (optional connector), link click, manual mark on the contact.
- Attribution: last journey or campaign touch within N days (host setting, default 7). Feeds goal conversion, “purchased” stop condition, attributed revenue.

### M — Engage shell and ops

- Routes `/host/engage/*`, sidebar per mock, `/host/crm` redirects.
- Meta: Tech Provider / App Review for `whatsapp_business_messaging` and `whatsapp_business_management` on customer WABAs, business verification, webhook fields `messages`, `message_template_status_update`, `phone_number_quality_update`, `account_update`.
- Token health: system-user token expiry and revocation shown on the channel card.
- Load test: 10k-contact campaign + 1,000 due journey steps at once, on 3 instances × `DB_MAX_CONNS=4`.
- Observability: River queue depth, oldest job age, send failures by Meta code; JSON logs on stdout (Cloud Logging now, Loki or files on a server).

## Order

1. **0** — River + always-on instance. Nothing else is reliable on scale-to-zero, 3-instance Cloud Run without it.
2. **A + B + C** (graph, window rule, reply waits, webinar summary). Custom fields from G land with A.
3. **D + E** (inbox needs conversations; team changes every handler, so do it once, early).
4. **F, G, H** templates/links/logs/attendance.
5. **L** before analytics revenue and the purchased stop condition go live.
6. **I** webhook and public API, then Sheets, Calendar, HubSpot, Zapier.
7. **J** before selling. **K** when a host asks for a second number. **M** ops runs alongside from the start; App Review has lead time, so file it during step 2.
