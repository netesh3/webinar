# Campaigns

**Status:** partial — create/list/cancel/stats exist; wizard UX does not  
**Mock:** `campaigns.html`, `modal-create-campaign.html` (five layers)  
**Code:** `store/crm_broadcasts.go`, `crm-broadcasts.tsx`

## Purpose

One approved template to many opted-in people, now or later. Marketing is
never silent: every recipient must have `whatsapp_opt_in_at` **regardless of
category** (stricter than Meta’s utility vs marketing split — see CRM plan
deviation 21).

## Done looks like

**List:** name, audience, template, status (derived: scheduled / sending /
sent / cancelled), funnel (queued, sent, delivered, read, failed, skipped).
No phone simulator on this screen.

**Create — five client steps, one POST at the end:**

1. Audience — `opted_in` | `webinar` | `tag`. Show funnel: matched → opted-in
   → eligible (`GET /crm/audience`).
2. Template — approved only.
3. Variables — `CRMParam` tokens, fallbacks, test send to self (optional;
   can be a send to the host’s own number if we have it).
4. Schedule — now / later; later: throttle + quiet hours (columns if missing).
5. Queued — confirmation; cancel still works until the outbox drains.

## Already built

- `GET /crm/audience` — counts (+ optional contact preview)
- `GET/POST /crm/broadcasts`, `GET /crm/broadcasts/{id}`,
  `POST /crm/broadcasts/{id}/cancel`
- Recipients materialised as `notifications` rows in **one transaction**
- Sweeper sends 100/tick; stats from outbox + `crm_messages`

## To build

- Wizard UI (Phase 10). Do **not** POST per step.
- Throttle / quiet hours if not in `crm_broadcasts` yet — sweeper consults
  them; do not add Redis.
- Per-host fairness + River job queue (plan 0) **before** large campaigns
  (architecture §10.2–10.3).
- Batch insert if audiences regularly exceed a few thousand (§10.4).

## Scale

10k recipients ≈ 50 minutes at 200/min **shared** across all hosts. A
broadcast must not starve `wa_reminder_1h`. Priority + per-host cap is part
of this feature’s launch, not a later optimisation.

## Coupling

Audience `webinar` = that host’s registrants (approved). Campaigns work
without it (`opted_in` / `tag`).

## Calls

List: 1 GET (stats included). Wizard: 1 audience GET per change of segment
(debounce), 1 templates GET if not cached, 1 POST to create.

## Tests

`crm_broadcasts_test.go` — opt-out excluded, cancel, isolation, tag audience.
Add: wizard does not leave partial broadcasts.

## On the wizard (plan F)

CSV of E.164 numbers, still opt-in checked. Marketing templates hidden unless the audience has marketing opt-in. Throttle and quiet hours are settings the sweeper reads. A/B tests and MMS are not on the mock. Unofficial blast APIs stay out.
