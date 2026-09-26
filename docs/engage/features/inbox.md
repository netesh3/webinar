# Inbox

**Status:** partial — thread + send + 20 s poll exist on `/host/crm`; the
shared queue, assignment, unread, and session-closed composer as a first-class
state do not.  
**Mock:** `inbox.html`, `inbox-session-closed.html`  
**Code:** `web/components/crm-screen.tsx`, `api/internal/api/crm.go`,
`store/crm.go`

## Purpose

This is the product. A host (or later an agent) opens Engage to **talk to
people**, not to configure journeys. Everything else exists so this screen is
honest: the host sees what the system already sent before they type.

## Done looks like

Three columns: **queue | thread | contact**.

**Queue**

- Filters: Open, Unassigned, Mine, Bot, Closed session (24 h elapsed).
- Each row: name, last body, unread, owner, window open/closed, source
  (journey / campaign / bot / human).
- Dashboard badge = open count from this query, not a second table.

**Thread**

- Oldest→newest, last 300 messages (`crmThreadMax`).
- Automated bubbles name the drip, broadcast, or bot (`bot_id` / broadcast id
  already stored).
- Window **open:** free-text composer (+ optional template).
- Window **closed:** composer is **replaced** by template picker, variables,
  preview, send — not a disabled textarea (`inbox-session-closed.html`).

**Contact pane**

- Phone, stage (when pipelines ship), tags, owner, last webinar, notes link,
  pause/resume bot.

## Already built

- `GET /api/host/crm/contacts` — list + counts + last message + last inbound.
- `GET /api/host/crm/contacts/{id}` — thread.
- `POST /api/host/crm/contacts/{id}/send` — text or template; server re-checks
  consent, window, template status.
- `PUT /api/host/crm/contacts/{id}/bot` — pause / hand back.
- Poll 20 s while the tab is visible.

## To build

| Piece | API | Notes |
| --- | --- | --- |
| Queue | `GET /api/host/crm/inbox` | Filters + unread + window flag in **one** query (LATERAL last message, same as Contacts) |
| Mark read | `POST /api/host/crm/inbox/{contactId}/read` | Until `crm_conversations` exists, unread can live on the contact |
| Assign | `POST …/assign` | Phase 9; v1 may omit |
| Unread | column or derived | Don’t scan the whole thread in the browser |
| Route | `/host/engage/inbox` | `/host/crm` redirects here |

Add `crm_conversations` when you need assignment, SLA clock, or a second
phone number. Until then thread = `(host_id, contact_id)` as today.

## Rules (server, every send)

1. Opt-out / STOP → refuse.
2. Free-form only if last **inbound** is < 24 h.
3. Else approved template only; param count must match.
4. Inbound is not consent.
5. STOP is a bare word (`STOP`, `UNSUBSCRIBE`, `STOP ALL`, `OPT OUT`), not a
   substring.

## Calls

Open: `GET inbox`. Select: `GET contacts/{id}` (thread already includes
contact). Poll: inbox only, 20 s, visible tab. Thread polls with the queue
while selected — still two GETs, not four.

Do not load templates on inbox open. Load them when the window is closed or
the host opens the template tab (cache is already in memory from a parent
load if they visited Templates; that’s fine).

**ETag** on the queue before SSE (architecture §11.2).

## Coupling

Webinar Liv is a **source** of contacts and of automated lines in the thread
(reminders, drips on `registered`). Inbox works with zero webinars.

## Scale

Queue page = same 200 cap as contacts until keyset cursor. 200 open tabs ×
3 req/min is fine on 3×4 Postgres conns. See architecture §10.

## Tests

Existing: isolation, STOP, status monotonic, send window.
Add: inbox filter window open/closed; unread clear; other host’s id → 404.

## Non-goals

Realtime via Supabase. WhatsApp calling. Group chats.
