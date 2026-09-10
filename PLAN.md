# Self-hosted webinar platform — build plan

An open-source Zoom Webinars / webinar.gg alternative you can host yourself and resell cheaply.

---

## 1. TL;DR — the stack I'd pick

| Layer | Pick | License |
|---|---|---|
| Media server (SFU) | **LiveKit** | Apache-2.0 |
| NAT traversal | **coturn** | BSD |
| Broadcast fan-out | **LiveKit Egress → LL-HLS → Bunny CDN** | Apache-2.0 |
| Recording | LiveKit Egress (room composite → MP4) | Apache-2.0 |
| App | **Next.js + `@livekit/components-react`** | MIT |
| API | Node (Fastify/NestJS) or Go | MIT |
| Data | **Postgres + Redis** | PostgreSQL / BSD |
| Realtime chat/Q&A/polls | LiveKit data channels (+ Postgres for persistence) | Apache-2.0 |
| Auth | **Zitadel** or Auth.js + Postgres | Apache-2.0 / ISC |
| Object storage | **Cloudflare R2** (zero egress fee) | — |
| Email | **Listmonk** + Amazon SES / Postmark | AGPL-3.0 |
| Payments | **Stripe**, or Paddle/Lemon Squeezy if you want VAT handled | — |
| Analytics | **PostHog** (self-host) | MIT |
| Hosting | **Hetzner** (dedicated or cloud) | — |
| Deploy | Docker Compose → k8s (LiveKit ships Helm charts) | — |
| Monitoring | Prometheus + Grafana + Loki + Uptime Kuma | Apache-2.0 / MIT |

**Why LiveKit over the alternatives:** it is the only option that gives you the SFU
*and* the boring-but-essential production pieces — Egress (recording + HLS), Ingress
(RTMP/WHIP in), token auth, autoscaling, and first-party SDKs for web/iOS/Android/Flutter
— under one permissive license. With mediasoup or Pion you write all of that yourself;
that's 3–6 months of work you don't need to do.

> Licenses are as of writing — re-verify before you ship, especially GPL/AGPL components
> if you ever distribute binaries rather than run a SaaS.

---

## 2. The one decision that decides your cost

**Do not send WebRTC to every viewer.** This is the mistake that makes self-hosted
webinar platforms expensive, and it's the whole reason Zoom charges $340/mo for a
1,000-attendee licence.

Split your audience into two tiers:

```
                    ┌──────────────────────────────────────────┐
   INTERACTIVE      │  Host + panelists + promoted attendees   │
   (WebRTC / SFU)   │  ~200ms latency · can talk · up to ~20    │
                    └──────────────────────────────────────────┘
                                      │
                            LiveKit Egress (compose + encode)
                                      │
                    ┌──────────────────────────────────────────┐
   BROADCAST        │  Everyone else — 100 to 100,000 viewers  │
   (LL-HLS / CDN)   │  2–6s latency · watch only · costs ~$0   │
                    └──────────────────────────────────────────┘
                                      +
                        WebSocket for chat / Q&A / polls / reactions
                        (so it still *feels* live, at ~50ms)
```

The trick is that **interactivity does not need to live in the video path.** A viewer
whose video is 4 seconds behind but whose chat, poll, and reaction are instant reads as
"live" to a human. That single insight is worth ~99% of your bandwidth bill.

### The math

Per viewer at 720p30 ≈ 1.5 Mbps ≈ **0.68 GB/hour**.

| Scenario | All-WebRTC | Hybrid (WebRTC stage + HLS audience) |
|---|---|---|
| 100 viewers × 1h | 68 GB, 1 small server | same, don't bother splitting |
| 1,000 viewers × 1h | **1.5 Gbps sustained** — ~5 dedicated boxes | 680 GB CDN = **$3.40** |
| 10,000 viewers × 1h | **15 Gbps** — ~40 boxes, absurd | 6.8 TB CDN = **$34** |

Below ~200 concurrent, plain WebRTC on one server is simpler and fine. Build the HLS
path when you sell your first 500-seat webinar, not before.

---

## 3. Architecture

```
                    ┌─────────────────┐
   Browser ────────►│  Next.js (Vercel│  landing pages, registration,
   (attendee)       │  or Hetzner)    │  room UI, dashboard
                    └────────┬────────┘
                             │ REST / tRPC
                    ┌────────▼────────┐      ┌──────────────┐
                    │  API (Fastify)  │◄────►│  Postgres    │  webinars, registrants,
                    │  - JWT minting  │      │              │  questions, polls, orders
                    │  - webhooks     │      └──────────────┘
                    │  - Stripe       │      ┌──────────────┐
                    └────────┬────────┘◄────►│  Redis       │  presence, rate limits,
                             │               └──────────────┘  BullMQ reminder jobs
                             │ room tokens
                    ┌────────▼────────────────────────────┐
                    │  LiveKit SFU  (Go, Apache-2.0)      │
                    │  publishes: host + panelists        │
                    └───┬──────────────┬──────────────────┘
                        │              │
              ┌─────────▼───┐   ┌──────▼──────────┐
              │  coturn     │   │ LiveKit Egress  │
              │  (TURN/     │   │ headless Chrome │
              │  relay ~15% │   │  + ffmpeg       │
              │  of users)  │   └──┬───────────┬──┘
              └─────────────┘      │           │
                          MP4 ─────┘           └───── LL-HLS segments
                             │                              │
                    ┌────────▼────────┐          ┌──────────▼────────┐
                    │ R2 / B2 (VOD)   │          │  Bunny CDN        │
                    └─────────────────┘          │  → 10k viewers    │
                                                 └───────────────────┘
```

---

## 4. Every option, layer by layer

### 4.1 Media server (the core choice)

| Option | License | Lang | Pick it if | Skip it if |
|---|---|---|---|---|
| **LiveKit** ⭐ | Apache-2.0 | Go | You want a product in weeks, need recording + HLS + RTMP out of the box, want to scale horizontally later | You need extreme low-level control of RTP |
| **mediasoup** | ISC | Node + C++ | You want maximum control and are comfortable writing your own signaling, recording, and scaling layer | You're a small team shipping to a deadline |
| **Janus** | GPL-3.0 | C | You love plugins, need SIP/streaming gateways, want the most battle-tested option | GPL bothers you, or you dislike C |
| **Jitsi (JVB)** | Apache-2.0 | Java | You want a working meeting app *today* — deploy `docker-jitsi-meet` and you're live | You want it to look like *your* product (reskinning Jitsi fights you constantly) |
| **Pion / ion-sfu** | MIT | Go | You're building something unusual and want primitives | You want batteries |
| **OpenVidu** | Apache-2.0 | Java | You want recording + broadcast bundled with a REST API | You want a small footprint |
| **Ant Media CE** | Apache-2.0 | Java | Your workload is mostly *broadcast* (WebRTC in, HLS/CMAF out at scale) | You need rich many-to-many |
| **BigBlueButton** | LGPL-3.0 | mixed | Your webinars are *teaching* — whiteboard, breakout rooms, polls, shared notes all included | You want light and embeddable — BBB is a big install |

**Recommendation:** LiveKit. Second choice for a "live this weekend" prototype: Jitsi.
Second choice if you need to own every byte: mediasoup.

### 4.2 TURN — don't skip this

~10–20% of users sit behind NAT/firewalls that block direct connections. Without TURN
they see a black screen and blame you.

- **coturn** (BSD) — the standard. Run it on a separate box with a real public IP, port
  443/TCP *and* UDP so corporate firewalls let it through.
- **eturnal** (Apache-2.0) — Erlang, lighter to operate, good alternative.
- TURN relays full media, so it's your bandwidth hog. Put it on Hetzner where egress
  is effectively free, never on AWS.

### 4.3 Broadcast / HLS fan-out

- **LiveKit Egress** → HLS directly. Simplest.
- **MediaMTX** (MIT) — one Go binary, ingests RTMP/SRT/WebRTC and outputs LL-HLS/WebRTC.
  Delightful to operate. My pick if you want a separate broadcast tier.
- **SRS** (MIT) — very mature, high performance, great docs (Chinese-first).
- **Owncast** (MIT) — a whole self-hosted Twitch. Good reference implementation to read.
- **nginx-rtmp** — works, but unmaintained; prefer MediaMTX.
- CDN in front: **Bunny** (~$0.005–0.01/GB, cheapest good option), Cloudflare, or
  Fastly. This is where your scale comes from.

### 4.4 Realtime (chat, Q&A, polls, reactions)

- **LiveKit data channels** — free, already connected, works for stage participants.
- **Centrifugo** (MIT) — dedicated WebSocket server, scales to 100k+ connections, has
  JWT auth, history, and presence built in. Use this for HLS-tier viewers who aren't in
  the SFU at all.
- **Postgres + `LISTEN/NOTIFY`** or **Supabase Realtime** — fine at small scale.

Persist everything in Postgres regardless — Q&A and chat transcripts are a feature you
sell (and export to CRM).

### 4.5 Recording & VOD

- **LiveKit Egress** room-composite → MP4 to S3-compatible storage. Budget ~2–4 CPU
  cores per concurrent recording (it's a headless Chrome).
- Storage: **Cloudflare R2** — $0.015/GB/mo and **zero egress**, which matters enormously
  for replays. **Backblaze B2** is cheaper to store, egress free up to 3× stored.
- Avoid self-hosted **MinIO** for this (AGPL, and you'd be paying for the bandwidth
  yourself). If you insist on self-hosting object storage, **SeaweedFS** is Apache-2.0.
- Post-process with **ffmpeg**: generate HLS renditions, thumbnails, and a transcript
  via **whisper.cpp** (MIT) — captions and searchable transcripts are a paid upsell.

### 4.6 Auth, payments, email, analytics

| Need | Options |
|---|---|
| Auth | **Zitadel** (Apache-2.0, modern, multi-tenant), **Keycloak** (Apache-2.0, heavyweight but bulletproof), **Authentik** (MIT), **Ory Kratos** (Apache-2.0), or just **Auth.js** + Postgres for MVP |
| Payments | **Stripe** (best API), **Paddle / Lemon Squeezy** (merchant-of-record — they handle global VAT/GST, worth the extra 2% if you sell internationally), **Razorpay** (India). Metering/billing logic: **Lago** (AGPL) or **Kill Bill** (Apache-2.0) |
| Transactional email | **Amazon SES** (cheapest), **Postmark** (best deliverability). Self-hosting SMTP for reminders will land you in spam — don't |
| Campaigns / reminders | **Listmonk** (AGPL) for broadcasts, **BullMQ** (MIT) or **Temporal** (MIT) for scheduled reminder jobs |
| Scheduling | **Cal.com** (AGPL) if you want booking; otherwise generate `.ics` yourself |
| Analytics | **PostHog** (MIT, self-host) — session replay + funnels, ideal for this. **Plausible**/**Umami** for page views |
| Whiteboard | **Excalidraw** (MIT), embeddable |

---

## 5. Product features that actually sell

Meetings and webinars are different products. These are the webinar-specific bits, and
some of them are where your margin lives:

**Table stakes**
- Registration page + confirmation + reminder emails (this alone drives show-up rate
  from ~25% to ~45% — it's the highest-ROI feature in the whole product)
- Backstage / green room — panelists rehearse before going live
- Attendees muted and camera-off by default; raise hand → host promotes to stage
- Moderated Q&A with upvoting; polls; reactions
- Replay/VOD with the original chat replayed alongside

**Where you differentiate (and charge more)**
- **Simulive / auto-webinar** — a pre-recorded video played on a schedule as if live,
  with live chat and a real host answering. Enormous seller in this market, and your
  marginal cost is *near zero* (no live encode, just CDN). Build this early.
- **Mid-webinar CTA / offer overlay** — a button the host fires that drops a pinned
  offer card into every viewer's screen. This is the single feature marketing customers
  buy webinar software for.
- **Multistream** — simultaneously push to YouTube/LinkedIn/X via RTMP fan-out
  (MediaMTX or **Restreamer**, both permissive).
- **White-label** — custom domain, logo, colors. Charge for it.
- **CRM export / webhooks** — HubSpot, Salesforce, Zapier. B2B buyers require it.
- **Attention tracking + engagement score** — who watched how long, who clicked the CTA.
  Sales teams pay for this list.

---

## 6. Cost model (real numbers)

Assumptions: 720p30 ≈ 1.5 Mbps ≈ 0.68 GB/viewer-hour. Hetzner cloud includes 20 TB
egress/mo, then ~€1/TB. Bunny volume tier $0.005/GB.

### Tier 1 — up to 200 concurrent, all WebRTC

| Item | Spec | €/mo |
|---|---|---|
| LiveKit SFU | CPX41 (8 vCPU, 16 GB) | 30 |
| coturn | CPX11 | 5 |
| App + API + Postgres + Redis | CPX31 | 15 |
| R2 storage (~100 recordings) | 150 GB | 2 |
| **Total** | | **~€52/mo** |

Runs **unlimited** webinars at this size. Compare: Zoom Sessions 500-attendee ≈ $79/mo
*per host*.

### Tier 2 — up to 2,000 concurrent, hybrid

| Item | Spec | €/mo |
|---|---|---|
| LiveKit SFU | AX41 dedicated, 1 Gbps unmetered | 45 |
| Egress/transcode | AX41 (4 cores per concurrent webinar) | 45 |
| coturn | CPX21 | 8 |
| App tier | CPX41 | 30 |
| Postgres (managed or self) | | 20 |
| CDN | 20 webinars × 2,000 × 0.68 GB = 27 TB × $0.005 | ~125 |
| **Total** | | **~€270/mo** |

### Tier 3 — 10,000 concurrent

Same servers, CDN scales linearly: **$34 per 10k-viewer-hour**. The servers do not
change, because only ~5 people are ever publishing. This is why the hybrid split matters.

### What to charge

Your cost per 1,000-attendee webinar is **under $5**. Market pricing:

| Product | 1,000 attendees |
|---|---|
| Zoom Webinars/Sessions | ~$340/mo |
| Demio | ~$266/mo |
| WebinarJam | ~$79–500/mo |
| **You** | **$29–99/mo** and still ~90% gross margin |

Suggested ladder: Free (50 attendees, watermark) → $29 (200, branding) → $79 (1,000,
simulive + CTA) → $199 (5,000, white-label + API) → custom.

---

## 7. Phase plan

### Phase 0 — validate (1 week)
Don't self-host yet. Use **LiveKit Cloud's free tier** to build the app against the same
SDK you'll self-host later. Ship a landing page and collect 10 registrations for a real
webinar you actually run. Learn what breaks socially before you optimise bytes.

### Phase 1 — MVP (2–4 weeks) → *sellable*
- Next.js app: landing/registration page, room, host controls
- LiveKit self-hosted on one Hetzner box + coturn
- Host + up to 10 panelists on WebRTC; up to 200 attendees also on WebRTC
- Screen share, chat, raise hand → promote to stage
- Recording to R2, replay page
- Postgres schema: `webinars`, `registrants`, `sessions`, `messages`, `questions`
- Reminder emails (24h + 1h) via BullMQ + SES

**Ship gate:** run 3 real webinars on it yourself before selling.

### Phase 2 — scale + monetise (3–4 weeks)
- LiveKit Egress → LL-HLS → Bunny; auto-switch viewers >200 to the HLS tier
- Centrifugo for the broadcast tier's chat/Q&A/polls
- Stripe checkout, plans, seat limits
- Q&A upvoting, polls, CTA overlay
- **Simulive** — schedule a recording to play as live

### Phase 3 — the product moat (4–6 weeks)
- Multi-tenant + white-label (custom domain via Caddy on-demand TLS)
- Analytics dashboard, engagement score, CSV/CRM export, webhooks
- Multistream to YouTube/LinkedIn
- Captions/transcript via whisper.cpp
- Mobile web polish (this is ~40% of attendees — do not defer it)

### Phase 4 — hardening
- LiveKit on k8s with autoscale; multi-region SFU + geo-DNS
- Prometheus/Grafana/Loki, alerting, status page
- Load test with LiveKit's `livekit-cli load-test`
- SOC2-lite posture if you're selling B2B

---

## 8. What will bite you

1. **Mobile Safari.** Autoplay needs `muted` + a user gesture; backgrounding kills the
   stream. Test on a real iPhone from day one, not the simulator.
2. **Corporate firewalls.** UDP is often blocked entirely. coturn on **TCP 443** is your
   fallback — without it, enterprise attendees simply can't join.
3. **Echo.** Two people in the same room with speakers on ruins the recording. Enforce
   headphones for panelists in the green room check.
4. **Egress CPU.** Headless Chrome is heavy. Two concurrent recordings on a 4-core box
   will drop frames. Size for peak concurrent *webinars*, not peak viewers.
5. **Bandwidth billing on the wrong cloud.** 10 TB egress: Hetzner €0, AWS ~$900.
   This is a 100× difference and it is the whole business.
6. **Reconnects.** People's wifi drops. Persist room state server-side so a refresh
   restores chat, poll state, and stage position.
7. **Time zones.** Store UTC, render in the viewer's zone, show the zone name explicitly
   on the registration page. Getting this wrong means empty webinars.
8. **Recording consent.** Show a visible indicator and a joining notice — GDPR, and in
   some jurisdictions two-party consent.
9. **AGPL in your dependency tree.** Fine to *use* over a network boundary; risky if you
   fork and distribute. Keep a licence inventory from day one.

---

## 9. First week, concretely

```bash
mkdir webinar && cd webinar
npx create-next-app@latest web --typescript --tailwind --app
pnpm add livekit-client @livekit/components-react @livekit/components-styles
pnpm add -D livekit-server-sdk

# local LiveKit
docker run --rm -p 7880:7880 -p 7881:7881 -p 50000-50100:50000-50100/udp \
  -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server \
  --dev --node-ip=127.0.0.1
```

Suggested layout:

```
webinar/
├── web/                  Next.js — landing, room, dashboard
├── api/                  Fastify — tokens, webhooks, Stripe
├── worker/               BullMQ — reminders, post-processing
├── infra/
│   ├── compose.yml       livekit, coturn, postgres, redis, caddy
│   └── helm/             phase 4
└── mock-ui/              ← the mockup, open index.html
```

Build order for week one: **token endpoint → join a room with two browsers → screen
share → chat → registration form.** In that order. Everything else is downstream of
those five working.

---

## 10. Mock UI

Open `mock-ui/index.html` in a browser. Three screens:

- **`live.html`** — the webinar room. Toggle between **host** and **attendee** views in
  the top bar; tabs for Chat / Q&A / Polls / People; working reactions, poll voting, and
  the CTA overlay.
- **`landing.html`** — registration page with countdown, agenda, and paid variant.
- **`dashboard.html`** — organiser dashboard: KPIs, concurrent-viewers chart, funnel, and
  a per-session infra cost panel so you can see your margin per webinar.
