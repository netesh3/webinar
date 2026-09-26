# Analytics

**Status:** planned (Phase 12)  
**Mock:** `analytics.html`

## Purpose

Read-only facts from rows we already write. No warehouse, no browser
aggregation of full message dumps.

## Panels

1. **Inbox** — opened vs resolved (if we have closed state), median first
   human reply, SLA %, mix window-open vs template-reopen, by agent if
   Phase 9 shipped.
2. **Campaigns** — last or selected broadcast: queued / sent / delivered /
   read / failed / skipped (already on `CRMBroadcastStats`).
3. **Journeys / bots** — `CRMDripStats` / `CRMBotStats`; plus
   `EndedReason` histogram (the useful one).

## API

- `GET /crm/analytics/inbox?from=&to=` (default 30 days)
- Campaigns: do **not** duplicate — `GET /crm/broadcasts/{id}` is enough
- Optional `GET /crm/analytics/bots/{id}/exits` grouped by `ended_reason`

Max **two** GETs to paint the page.

## Rules

Time bounds required. Caps on scan: filter `crm_messages.created_at`.
Index `(host_id, created_at)` if the planner complains.

## Coupling

Webinar attendance funnels stay in Webinar Liv. Engage may show “registered
via webinar X” as a breakdown **only** if it is a `GROUP BY` on existing
`registration_id` / enrollments, not a join into LiveKit.

## Also on the mock (plan H)

Period (7 / 30 / quarter / year) and audience filter. Link CTR, show-up rate, show-up by channel, attributed revenue (from the journey goal, not a payments product), inbox by agent with breaches, top automations with goal and conversion, CSV export of those aggregates. A human reply pausing the journey for 24 h is a journey rule, surfaced here.
