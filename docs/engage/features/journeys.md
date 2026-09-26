# Journeys

**Status:** partial — linear template drips and a list editor are in Go; the mock is the graph in [plans](../PLANS.md) A–C  
**Mock:** `journeys.html`, `journey-builder.html`, `journey-builder-spacious.html`, `step-branch-rules.html`, `modal-create-journey.html`  
**Code today:** `store/crm_drips.go`, `api/internal/api/crm_drips.go`, `crm-drips.tsx`  
**Tech:** [PLANS.md](../PLANS.md) — our Go graph interpreter, run as River jobs on Postgres, `@xyflow/react` canvas. Not Temporal.

## Purpose

A journey is the host’s automation: a trigger, then a graph of messages,
waits, and branches. It is the workflow product. Bots are the inbound-message
trigger plus quick-reply buttons on this same graph, not a second engine.

Message steps include **free-form text**. Meta only accepts that text inside
the 24-hour service window. Outside it, the same step sends its approved
template (session fallback). The step is never omitted because the window
might be closed. See [PLANS.md](../PLANS.md) “Window rule”.

## Done looks like

Plans A–C. In short:

- List with trigger, step count, enrolled, delivered, active / paused / draft, goal conversion.
- Canvas (`@xyflow/react`): template message, free-form body, quick replies, if/else, wait, converge.
- Branch screen: predicates, AND, test without sending.
- Draft vs publish. Pause keeps place and sends nothing.
- Stop on opt-out, block, or the host’s purchased tag/stage. Quiet hours slide `next_due_at`.
- A human reply pauses that enrollment for 24 h.
- Triggers: webinar registration, ended / attended / no-show (already in Go) with watch minutes and attendance tier added, tag added, contact added, field changed, inbound message, inbound webhook, schedule, date field, conversion event, manual enroll.
- “VIP community member” is a custom field. Cloud API cannot see WhatsApp group membership.
- Blueprints from the create dialog, copied into a draft graph.
- Plans A–C and 0 in [PLANS.md](../PLANS.md) are the full list.

## Runtime

One interpreter, run by River. It needs plan 0 first: today there is no locking across instances, and with `--min-instances 0` nothing runs while the service is idle. River needs an always-on process, on Cloud Run or a dedicated server.

1. Trigger inserts `crm_journey_enrollments` on the first node and, in the same transaction, a River `journey.step` job with `ScheduledAt` = that node’s wait (or now).
2. River hands due jobs to workers (`SKIP LOCKED` inside River). Unique by (enrollment, node).
3. Condition nodes evaluate in Go and move the pointer. They do not send.
4. Message nodes follow the window rule, then advance.
5. Template sends go through `notifications` (one row + pointer bump in one transaction). Session sends use the inbox Graph path and only run when the window is open.
6. `next_due_at` is `now() + delay`, or the resolved wait-until. A late enrollment does not burst. Quiet hours push the timestamp forward.
7. Wait-until expressions recompute when webinar start changes.
8. Publish swaps `published_graph`. In-flight enrollments continue on the published graph; a deleted node ends those sessions `node_missing` after the editor has shown how many people are standing on it.
9. Opt-out exits every active enrollment and skips pending outbox rows (`exitDripsForContact`, generalised).

Throughput after plan 0: ~20 `wa.send` workers per instance, capped ≈50 msg/s per sender number; journey steps and campaigns on separate River queues so one cannot starve the other.

## Graph

Nodes have a `key`. Edges are keys. Layout x/y is a column the walker ignores.

| Kind | Sends | Notes |
| --- | --- | --- |
| `trigger` | no | One per journey. Kind is the plan C list |
| `template` | outbox | Approved name + language + param map |
| `session` | inline if window open, else template fallback or park | Free-form body, optional ≤3 buttons |
| `condition` | no | Attribute, operator, value, AND. Missing attribute → false path |
| `wait` | no | Delay, wait-until, or repeat up to N |
| `set_tag` | no | |
| `handoff` | optional text | Pauses automation, shows the thread in inbox |

Save draft writes `draft_graph` only. Publish validates the whole graph: every edge names a node, every template is sendable, every cycle has a finite N. No per-node autosave that can run a half-written edge.

## Coupling

`registered` / stream ended / attendance are the Webinar Liv joint. A journey with only manual, tag, webhook, or schedule still runs with zero webinars.

## Calls

List: 1 GET. Open builder: 1 GET (graph + per-node counts). Save draft or publish: 1 PUT. Test evaluation: 1 POST, no send. Do not poll enrollments on the list.

## Tests

Time injected. Pause. Opt-out exit. Quiet hours slide. Window open sends the body; window closed sends the template; window closed with no template parks. Branch false when the attribute is missing. Publish rejects a cycle with no cap. Two hosts cannot read each other’s graph.

## Already shipped (do not break while the graph lands)

Linear steps `{ delayMinutes, template, language, params }`, triggers `manual`, `registered`, `attended`, `no_show`, `ended`, `tag_added`, pause, opt-out exit, enroll API. The graph publish path replaces that step list; it does not run beside it.
