# Dashboard

**Status:** planned  
**Mock:** `dashboard.html`

## Purpose

One glance: is WhatsApp connected, is the inbox on fire, did the last
campaign land. Not a second analytics product.

## Done looks like

Cards:

- Connect / quality / phone (from existing WhatsApp link on Account)
- Open conversations, unassigned, SLA hit (SLA = Phase 9; until then omit)
- Team workload (Phase 9; omit if host-only)
- Last broadcast funnel (from `GET /crm/broadcasts` first row — **or**
  include in overview)
- Setup checklist (already `GET /crm/setup`)

## To build

`GET /api/host/crm/overview` — **one round trip**. Compose in Go from
setup + inbox counts + latest broadcast stats. Do not let the dashboard
fire four list endpoints (architecture §11.1).

Route: `/host/engage`.

## Coupling

May show “next webinar” as a **link out** to Webinar Liv. Must render fully
if the host has zero webinars.

## Calls

Exactly one GET on open. No poll unless inbox counts are on this screen
and the tab is visible — prefer linking to inbox rather than polling two
pages.
