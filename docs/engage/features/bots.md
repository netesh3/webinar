# Bots (conversation flows)

**Status:** partial — runtime + list editor; canvas is Phase 11  
**Mock:** overlap with journey builder / branch rules (those screens were drawn
as one “flow” — in code they map here, not to drips)  
**Code:** `store/crm_bots.go`, `api/internal/api/crm_bots.go`, `crm-bots.tsx`

## Purpose

Answer **inbound WhatsApp** in seconds with the host’s own words, inside the
24-hour window. Keyword or catch-all. Hand off to a human.

Sends **inline on the webhook**, not through the outbox, so the person holding
the phone is not waiting on a 30 s tick.

## Done looks like

- Trigger: `any_message` or `keyword` (list, lowercased, de-duped). Only one
  **active** catch-all per host (`ErrConflict`).
- Nodes (one struct, `key` identity):

  | Kind | Behaviour |
  | --- | --- |
  | `message` | Say `text`, go `next` |
  | `ask` | ≤3 reply buttons (Meta cap); `next` = fallback; empty fallback = handoff |
  | `wait` | Sleep ≤24 h; sweeper wakes (`AdvanceBots`, 50/tick) |
  | `enroll` | Put them on a drip; missing drip = skip, don’t die |
  | `set_tag` | Apply tag; missing tag = no-op |
  | `handoff` | Pause bot on the **contact**, surface in inbox |

- Graph validated on save: every `next` exists, no cycles.
- Sessions kept after end. `EndedReason`: `handed_over`, `host_took_over`,
  `window_closed`, `node_missing`, `too_many_steps`, `opted_out`, `bot_off`,
  `send_failed`, `whatsapp_disconnected`.
- Step budget 60. Last `wamid` stored so redelivery is idle.
- Host pause: `PUT /crm/contacts/{id}/bot` `{ paused }`.

## Runtime

Webhook → `BotForMessage` / latest session → run nodes until wait, ask, or
end → Graph send → persist session. `wait` resumes in `AdvanceBots`.

If the window closed while sleeping → `window_closed`, **no** template
fallback (host words have no HSM). To continue after 24 h, `enroll` a drip
before the wait, or hand off.

## Builder (Phase 11)

Same payload as `PUT /crm/bots/{id}`. x/y in a layout blob the runtime
ignores. Whole-graph save only. Show parked session counts per node.

Do not autosave nodes. A half-written edge must not run.

## Coupling

Bots do not need webinars. `enroll` is how a chat starts a journey that
survives the window.

## Calls

List 1 GET. Editor 1 GET by id (nodes + stats). Sessions list when reviewing
a bot, paged. Inbox does not fetch all bots — only pause state on the contact.

## Scale

1,000 sleeping sessions due at once → 50/tick ≈ 10 minutes. Webhook path must
stay one session + ≤40 nodes in one read (already: whole flow at once).

If webhook + Graph approaches Meta timeout, queue the reply; keep the budget.

## Tests

`crm_bots_test.go` — cycle reject, button cap, pause holds next message,
wamid idempotency, window_closed, step budget.

## Where this goes

Quick replies, handoff, and “any inbound message” are nodes and a trigger on the journey graph ([journeys.md](journeys.md), plans A–B). This runtime stays until that graph publishes. LLM replies, Meta WhatsApp Flows, and voice are not on the mock.
