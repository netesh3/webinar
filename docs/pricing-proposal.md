# Pricing proposal (2026-10-24)

**Status: proposal. Nothing here is charged yet.** The live price list is still
`api/internal/billing/billing.go` (`Plans`). The pages built on this proposal are
`/features` and `/pricing/proposed`. Both are `noindex`, show a "proposed pricing" note and
send buyers to the live `/pricing`, until `PLANS_STATUS` in `web/lib/plans.ts` is flipped
to `"live"`. That file is the one typed source for every number below; both pages read it,
and `web/lib/plans.test.mts` checks that the comparison table matches the plan limits.

## 1. Where we are today (from the code)

| | Professional | Business | Enterprise |
|---|---|---|---|
| Price a month | ₹3,999 / $49 (list ₹9,999 / $99) | ₹9,999 / $199 (list ₹24,999 / $399) | Contact (records say ₹39,999 / $499) |
| Attendees (`PlanAttendeeCap`) | 200 | 300 | 500 |
| Stage (`PlanStageCap`) | 3 | 5 | 10 |
| Meeting cap (`PlanMeetingCap`) | 10 | 10 | 10 (admins can raise any account to 50) |
| Recording storage (`plan_limits`, 0148) | 10 GB | 50 GB | 200 GB |
| Retention | 30 days for everyone (`RECORDINGS_RETENTION_DAYS`), then Keep longer +3 months at a time | | |
| AI | Off in every tier (`plan_features`, 0127). One spend cap for every plan: $2 per host a month (`AI_HOST_MONTHLY_USD`) and $20 for the whole instance | | |
| Yearly | 2 months free (INR rounded down to a figure ending in 9) | | |
| Trial | 7 days, card or UPI mandate, INR only, Professional limits (`limits_plan`) | | |

Gaps the proposal fixes:
- The tiers differ almost only by attendee cap. Business costs 2.5× Professional (4× in USD) for 100 more seats.
- Nothing limits usage hours. One host running 500 people for 80 hours a month costs about 8× a typical host.
- AI, clips, repurpose, WhatsApp CRM, Zoom, simulive and cloud recording are admin switches rather than plan features, so there is nothing to sell.
- The USD price of Business ($199) is about 1.7× its INR price at ₹100/$. Starter is at parity.

## 2. What ships (checked against the code)

The full list is on `/features`, and it is the `COMPARISON` table in `web/lib/plans.ts`.
Each item was checked in code. The main ones:
- **Live sessions.** Webinars on a LiveKit SFU with simulcast and gated AV1 (Chromium only, 8+ cores).
- **Edge delivery.** LL-HLS through the CDN. It is the only mode on GCP and DigitalOcean.
- **Meetings.** Lobby, cap 10, an admin can raise it to 50.
- **Simulive.** From an upload or a past recording, with engagement replay and AI auto mode.
- **Recording.** Cloud recording (composite, or the edge mix) and local recording, with English captions (Whisper `en`).
- **In-room tools.** Polls, quizzes, surveys, Q&A, chat with images and @mentions, reactions, raised hands, offer pop-ups, whiteboard, and video share (file, Drive or recording).
- **Video.** Picture-in-picture, backgrounds and blur, noise suppression, low-light correction.
- **Registration.** Pages with custom questions, approval, email reminders with .ics invites, recurring webinars, push notifications.
- **Data.** Audience rollup, CSV exports, Engagement Score.
- **WhatsApp CRM.** Reminders, broadcasts, drips, chatbot, inbox.
- **AI.** Write with AI, recap with insights, Q&A clustering and answer drafts, a knowledge base (documents, links, Obsidian vault), spam filter (rules plus an AI pass), and follow-up drafts sent by email or WhatsApp.
- **Content.** Repurpose (blog, newsletter, LinkedIn, X, Instagram, in a brand voice), highlights and reels, Studio.
- **Integrations.** Zoom (sessions on the host's own account), and streaming to YouTube or by RTMP to LinkedIn, Facebook and Instagram.

**Not built, so not claimed:**
- team or multi-seat accounts
- SSO
- custom domains
- branding beyond a cover image
- a public API or customer webhooks
- paid tickets
- ESP integrations (email goes out over SMTP)
- languages other than English for captions

The pages do not promise "host seats". Every account is one host who invites co-hosts and panelists to each session.

## 3. Proposed plans

| | **Starter** | **Pro** (most popular) | **Business** | **Enterprise** |
|---|---|---|---|---|
| Monthly, before GST | **₹4,999 / $59** | **₹9,999 / $149** | **₹24,999 / $349** | Contact |
| Yearly (2 months free) | ₹49,908 / $590 (₹4,159 a month) | ₹99,948 / $1,490 (₹8,329) | ₹2,49,948 / $3,490 (₹20,829) | Contact |
| Attendees per webinar | 200 | 500 | 1,000 | 1,000+ |
| Attendee-hours a month | 2,500 | 10,000 | 25,000 | Custom |
| People on stage | 3 | 5 | 10 | Custom |
| People per meeting | 10 | 10 | 25 | Up to 50 |
| Recording storage | 10 GB | 50 GB | 200 GB | Custom |
| Recordings kept for | 30 days | 90 days | 365 days | Custom |
| AI credits a month | Add-on (₹799 / $9 for 500) | 1,000 | 5,000 | Custom |
| Clip and reel renders a month | — | 30 | 100 | Custom |
| WhatsApp CRM, repurpose, clips and Studio, YouTube/RTMP, Zoom | — | ✓ | ✓ | ✓ |
| Priority WhatsApp support, onboarding | — | — | ✓ | ✓ |

**Every plan includes:**
- webinars on edge delivery, meetings and simulive with engagement replay
- cloud and local recording, and captions
- every in-room tool
- registration with approval, email and push reminders
- the Audience list, Engagement Score and CSV exports
- the rules-based spam filter

**Free trial:** 7 days with Pro limits and 200 AI credits. It keeps today's mechanics: a mandate, INR only, once per person.

**Why Pro at $149, not $199:** it brings USD closer to INR parity and sits under Zoom Webinars 500 and WebinarJam Professional. It is still about 2× Starter for 2.5× the attendees, 4× the attendee-hours, and AI.

### Attendee-hours: the unit that follows the cost

Video delivery is most of the bill, and it scales with *people × hours watched*, not with
the number of webinars. One attendee watching for one hour is one attendee-hour. 2,500
covers, for example, ten 1-hour webinars of 250 people. When a month's allowance runs out,
sessions keep running; we nudge the host to buy a pack or upgrade. **Hard stop or soft
limit is an open decision.**

### Add-ons

| Add-on | INR | USD | Our cost | Margin |
|---|---|---|---|---|
| AI add-on for Starter: 500 credits a month and the knowledge base | ₹799/mo | $9/mo | ≤ $0.50 | ~90%+ |
| Extra AI credits: 1,000 | ₹399 | $5 | ≤ $1 | ~75%+ |
| Extra attendee-hours: 5,000 | ₹2,999 | $39 | ~$16.5 (at $0.0033 per attendee-hour, all-in) | ~44% INR / ~58% USD |
| Extra recording storage: 50 GB | ₹299/mo | $4/mo | ~$0.75 on R2 | ~75% |
| Extra clip renders: 20 | ₹499 | $7 | server time between sessions, plus storage | high |

### AI credits

| Action | Credits | Model cost to us (calculator defaults) |
|---|---|---|
| Recap, chapters and insights | 10 per session hour | ~$0.002 per hour (gpt-5-nano) |
| Q&A answer draft or auto-mode answer | 1 per answer | ~$0.0004 |
| Q&A grouping and hot-lead scoring | 5 per session | ~$0.004 |
| Follow-up draft | 1 per attendee | ~$0.0002 |
| Repurpose draft | 5 per draft | $0.002–0.005 |
| Write with AI | 1 per draft | < $0.001 |
| Highlights and reel plan | 10 per recording hour | ~$0.01 (gpt-5-mini) |

A credit costs at most about $0.001, so Business's 5,000 credits are at most about $5 of
model spend. A typical host's AI is $0.18 a month in the calculator. Credits exist to
make AI a visible, sellable allowance with a hard ceiling, not because AI is expensive.
Indexing the knowledge base and the rules-based spam filter use no credits.

## 4. Unit costs and margins

Source: `web/lib/cost-calculator.ts` with its defaults (2026-10-22 provider prices), run
with a scratch script. The assumptions:
- Provider: DigitalOcean BLR1 c-4 on demand, the platform we are moving to.
- 20 paying coaches share the fixed costs.
- ₹100 = $1.
- A 2% payment fee and ₹300 a month of support and overhead per coach.
- Prices exclude GST, so the GST is passed through.
- USD revenue is net of a 3% international card fee.

**Unit costs:**
- **An edge attendee-hour:** about $0.0026 on DigitalOcean or Hetzner, and $0.007–0.010 on GCP. That is $0.005/GB CDN, a 1.1 Mbps mix, 3 origin pulls and the render box.
- **Including email, recording and API traffic:** about $0.0033.
- **A WebRTC (SFU) attendee-hour:** $0.010–0.012 on DigitalOcean, about $0.001 on Hetzner (20 TB of traffic included), and **$0.15–0.16 on GCP**. Large audiences must stay on edge.
- **Fixed costs per coach a month:** $7.3 at 20 coaches, $15 at 5 coaches, $3 at 100 coaches. This covers the video box on demand, the API droplet, Supabase and Workers.

### Worst case: every included attendee-hour used, at the attendee cap, on edge

Each plan also runs its meetings in this scenario (10×10, 20×10 or 40×25 person-hours).

|---|---|---|---|---|---|---|---|---|
|---|---|---|---|---|---|---|---|---|
| Starter ₹4,999 / $59 (margins below were computed at ₹3,999; higher now) | 2,500 | $16.1 | **51%** | 60% | 31% | 63% | −13% | 66% |
| Pro ₹9,999 / $149 | 10,000 | $40.8 | **55%** | 70% | 44% | 57% | −20% | 62% |
| Business ₹24,999 / $349 | 25,000 | $108.5 | **55%** | 67% | 53% | 55% | −76% | 66% |

### Typical use: half the attendee cap, a quarter of the hours, a few small meetings

| Plan | Cost a month (DO, 20 coaches) | Margin, INR |
|---|---|---|
| Starter | $6.4 | 76% |
| Pro | $13.8 | 83% |
| Business | $39.0 | 83% |

### What the table says

- On DigitalOcean or Hetzner, every plan keeps at least 50% margin at 20 coaches (31% for Starter at 5 coaches) even when the host uses everything included. The attendee-hours allowance is what makes that true.
- With no hours limit, the "500 attendees for 40 hours" host costs $75 a month on Pro, and the 1,000-attendee, 80-hour Business host costs $300 or more.
- **GCP loses money on every worst case.** The meeting egress at $0.12/GB dominates. This is one more reason to finish the DigitalOcean move before relaunching prices.
- Below about 5 paying coaches, fixed costs dominate: Starter's worst case falls to about 31% margin. That is acceptable for a launch.
- AI is a rounding error: under $1 a month even at full credit use.
- WhatsApp is billed by Meta to the host's own account and is not in our cost.

## 5. Competitors (approximate list prices; **check before quoting**)

| Product | Entry | Mid | Notes |
|---|---|---|---|
| Zoom Webinars | ~$79–90/mo per licence for 500 attendees (~$690/yr) | 1,000 attendees ~$3,400/yr | Licence per host; AI Companion bundled; no WhatsApp |
| WebinarJam | ~$39/mo (yearly), 100 attendees | ~$79/mo, 500; ~$379/mo, 2,000–5,000 | Live only; EverWebinar (automated) is a separate ~$42–50/mo |
| Livestorm | Free (30 live attendees, 20 min) | ~$99/host/mo for 100 live attendees; Business custom | Per-host seats; strong integrations |
| StreamYard | ~$35–45/mo Core | ~$69–89/mo Advanced | A streaming studio, not a webinar platform: no registration, CRM or engagement scoring |

Our position: Starter at $49 for 200 attendees is around WebinarJam Basic and well below
Livestorm Pro. Pro at $149 for 500 attendees includes simulive (which WebinarJam sells
separately as EverWebinar), WhatsApp and AI. INR pricing with GST invoices, and UPI, is
something none of the four offers natively.

## 6. Open decisions for you

1. **Prices.** Pro $149 (proposed) or keep $199? Business at ₹24,999 / $349?
2. **Early-bird list prices.** The server shows struck-through list prices today (₹9,999 / ₹24,999). Keep "launch offer" framing on the new plans, or drop it?
3. **Attendee-hours.** Soft limit with a nudge (proposed), or a hard stop at 0? Do unused hours roll over?
4. **1,000 attendees on Business.** `MAX_ATTENDEES` defaults to 500 and the 1,000 edge path has not been load-tested. Ship Business at 500 until it has?
5. **AI on Starter.** Add-on (proposed), or a small included allowance (say 100 credits) as a taster?
6. **Grandfathering.** Do existing Professional and Business subscribers keep their price (Razorpay subscriptions keep their amount by default), and do current Business customers (300 seats, $199) move to Pro (500, $149)?
7. **Trial.** Pro limits (proposed) or Starter? Add a USD trial?
8. **Cancellation.** Today a cancelled subscription stops at once. Switch to "runs to the end of the paid period"?
9. **Team seats.** Not built. Is it Enterprise-only later, or a Business feature to build next?
10. **Retention.** 90 or 365 days on Pro and Business against an Enterprise upsell. Storage cost is negligible on R2 either way.

## 7. Going live: what would have to change (not in this PR)

Server (Go):
1. **`api/internal/billing/billing.go` `Plans`.** Change the names, `Who`, `Features` and `Monthly` (INR and USD), and `ListMonthly` (decision 2). Make Business (server id `enterprise`) buyable: drop `ContactOnly`. Add a contact-only Enterprise row, which needs a new `types.Plan` value (e.g. `custom`) and `Valid()`.
2. **`api/types/types.go`.**
   - `PlanAttendeeCap`: 200 / 500 / 1,000.
   - `PlanMeetingCap`: per plan, 10 / 10 / 25.
   - `PlanStageCap`: already 3 / 5 / 10.
   - Raise `MAX_ATTENDEES` in deploy config to 1,000 after a load test.
3. **A new migration.**
   - Add the new plan id to the `plan_limits` CHECK.
   - New `plan_limits` keys: `retention_days`, `attendee_hours`, `ai_credits` and `clip_renders`.
   - `recording_storage_bytes` already matches (10 / 50 / 200 GB).
   - `limits_plan()`: trials count as `business` (Pro) instead of `professional`.
4. **The `plan_features` tier matrix.**
   - Pro and up: on for `ai`, `repurpose`, `clips`, `whatsapp_crm` and `zoom`.
   - Every tier: on for `cloud_recording`, `simulive`, `replay_engage` and `edge_delivery`.
   - Keep admin per-account overrides.
5. **Metering that does not exist yet.**
   - Attendee-hours per account per month: attendance data exists; it needs a monthly counter and a nudge.
   - An AI credit ledger to replace the flat `AI_HOST_MONTHLY_USD` with per-plan credits. Keep the instance-wide `AI_MONTHLY_USD` as a safety cap.
   - A clip render counter.
6. **Add-ons.** One-time Razorpay orders, plus a recurring item for the AI add-on and storage. There is no checkout for them today.
7. **Razorpay.** Plan ids are created lazily per (plan, currency, amount) in `razorpay_plans` (`razorpayPlanFor`), so new amounts make new Razorpay plans by themselves. Existing subscriptions stay on their old plan id and amount (decision 6).

Web:
1. Set `PLANS_STATUS = "live"` in `web/lib/plans.ts`. Doing so does three things:
   - takes away the noindex
   - lists `/features` in the sitemap
   - adds Features to the signed-out top nav
2. Move the `plans-ui` sections onto `/pricing`, keeping its Razorpay checkout and `?buy=` flow. Point the plan cards' buttons at `pricingHref({ plan, ... })`. Delete `/pricing/proposed`.
3. Have the server's `/api/billing/plans` and `lib/plans.ts` agree. Either generate one from the other, or add a test that fetches the catalogue and compares.
4. Update `web/lib/cost-calculator.ts` `PLAN_CAPS` and `RECORDING_QUOTAS`, the `COSTS.plan` text in `web/lib/admin-costs.ts`, and the home page FAQ.

## 8. Not verified

- **Competitor prices.** From memory of public pricing pages; not fetched.
- **Provider prices.** The calculator's defaults; several are marked ASSUMED in its header (DO c-2, API droplet, Hetzner hourly).
- **Delivery at 1,000 concurrent attendees.** Not measured.
- **AI token counts per action.** The calculator's estimates, not billing data.
- **Fees.** The 3% international card fee and the 2% domestic fee are typical Razorpay rates, not checked against our contract.
