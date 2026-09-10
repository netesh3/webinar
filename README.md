# Webcast — self-hosted webinars

Zoom-Webinars-shaped platform on entirely open-source infrastructure. Webinars
only; no meetings. Sized for **500 concurrent attendees** per session.

| Layer | Choice | Licence |
|---|---|---|
| Frontend | Next.js 16 · React 19 · Tailwind 4 | MIT |
| API | Go 1.27 · chi · pgx | MIT / BSD |
| Media (SFU) | LiveKit 1.13.6 | Apache-2.0 |
| Database | PostgreSQL 18 | PostgreSQL |
| Media transport | WebRTC | — |

## The two ideas worth understanding

**1. A webinar is a meeting with a different access token.** Nothing else about
the media path changes.

```go
// api/internal/lk/lk.go
host:     CanPublish(true),  CanSubscribe(true), CanPublishData(true), RoomAdmin
panelist: CanPublish(true),  CanSubscribe(true), CanPublishData(true)
attendee: CanPublish(false), CanSubscribe(true), CanPublishData(true), Hidden
```

That third line is the product: attendees receive media, send chat/Q&A/reactions
over data channels, and cannot broadcast. The role is derived **server-side** from
database state — a client cannot ask for a role.

> **Trap:** LiveKit's permission fields are `*bool`, and it reads `nil` as *grant
> everything*. An attendee grant with `CanPublish` left nil silently lets all 500
> attendees broadcast video. `internal/lk/lk_test.go` asserts the pointers are
> non-nil for every role, and the E2E test re-verifies it against a live SFU.

**2. "Attendees can't see each other" is a token flag, not a UI filter.**
`Hidden: true` makes the SFU stop telling other participants that this one
exists. A patched client bundle still cannot enumerate the audience, because the
participant records are never sent to it.

The consequence worth knowing: the host's browser can't see them either. So the
host's participant list is fetched from **our API**, which reads LiveKit's
server-side roster — that one does include hidden participants. Without that, a
host could hide the audience and then be unable to mute or remove anyone in it.

```
                    ┌── attendee's browser: sees the stage only
attendee joins ──►  SFU
  (hidden=true)     └── host's browser: also sees the stage only
                                │
GET /api/host/…/participants ──►│ server API: sees everyone, hidden included
```

`lk.HiddenFor(role, hideAttendees)` is the single place that decision is made —
it is called when minting a token, when promoting an attendee mid-session, and
when the host flips the control, and three copies of it would eventually disagree
about whether a promoted attendee is still hidden.

## Quick start

```bash
./start.sh                 # everything, health-checked, in the background
open http://localhost:3000
./stop.sh                  # when you're done
```

`start.sh` starts Postgres, the LiveKit SFU, the Go API and the frontend in that
order, waiting for each to answer before starting the next — so a failure names
the service that broke instead of showing up later as a blank page. It adopts
anything already healthy, so running it twice is safe. Logs go to
`.run/logs/{livekit,api,web}.log`.

| | |
|---|---|
| `./start.sh` | start everything |
| `./start.sh --rebuild` | force a rebuild of the API and LiveKit binaries |
| `./start.sh --logs` | start, then tail all logs |
| `./stop.sh` | stop web, API, SFU (Postgres left alone) |
| `./stop.sh --db` | also stop Postgres |
| `./stop.sh --all` | also close the E2E's headless browsers |

Seeded host accounts (development only): `neeraj@acme.dev`, `priya@acme.dev`,
`marco@streamline.io` — password `webcast-dev`.

### Try it with three users

1. **Browser 1** → `/login` → sign in → open a webinar → **Start webinar** →
   check your camera on the pre-join screen → **Join the webinar**
2. **Browsers 2 and 3** (separate profiles or incognito windows) → `/` →
   register for the same webinar → **Join the webinar**

Then, as the host, open **Controls**: mute everyone, hide the audience, lock the
room. `make room SLUG=scaling-webrtc-10k` shows what the SFU thinks, including
who is hidden.

## Accounts

One account type. Hosting is a **capability** on an ordinary account rather than a
separate kind of login, because the same person registers for other people's
webinars and runs their own — and a product with two front doors makes them pick
the wrong one.

| | |
|---|---|
| Sign up / sign in | `/signup`, `/login` — any account |
| Become a host | a toggle at signup, or later from `/account` |
| Speak as a guest panelist | any account, no hosting needed |
| Attend without an account | still fully supported |

`requireHost` checks `users.can_host` on **every** write under `/api/host`, so an
attendee account with a valid session cannot reach a host endpoint by guessing the
URL, and no request carries a field that says "make me a host".

Two routes under `/api/host` deliberately need only a session: joining a stage and
listing the stages you are booked on. A guest speaker is invited by name to
somebody else's webinar, and requiring the hosting capability to walk through a
door you were invited through would be a 403 with nothing in the product to explain
it. Both authorize themselves — join checks owner-or-panelist, and the list only
ever returns your own rows.

Registering while signed in links the registration to the account, so it follows
the person to another browser. Registering without one returns a 12-character join
key which **is** the credential — the same model as the personal link Zoom emails
out — and the browser keeps it in `localStorage`. Both paths are merged behind one
hook, so every screen asks one question and gets one answer.

## What the host can do live

All of it from the **Controls** panel in the room. Every change is persisted *and*
mirrored into LiveKit room metadata, which is how one click reaches 500 browsers
without any of them polling.

| Control | What actually happens |
|---|---|
| **Mute everyone** | Mutes every published microphone except the host's own, latches `mute_on_entry` so somebody joining ten seconds later is not live, and takes the microphone out of every speaker's grant so the first person to click unmute does not undo it |
| **Hide attendees** | `hidden=true` on attendee tokens; toggling mid-session rewrites the permission of everyone already connected |
| **Lock** | New attendees are refused; people already in are unaffected |
| **Allow to speak** | The microphone and *only* the microphone: `CanPublishSources: [microphone]`, no camera, no screen share. The common case when a host takes a live question |
| **Bring on stage** | A full seat — camera and screen share too. Both apply to the live connection, so there is no rejoin, and both survive one |
| **Mute one** | Two operations: the live track is silenced *and* the microphone leaves their grant, so they cannot unmute themselves. Only the host lifting it, or a fresh grant, gives it back |
| **Remove speaker permission** | Mutes them, drops them back to the audience, and re-hides them if the audience is hidden |
| **Dismiss request** | Answers a raised hand without granting anything, and lowers it on their screen too |
| **Record** | Host or panelist. One at a time, everyone in the room is shown an indicator, and the file appears under Recordings on the webinar's page — see [Recording](#recording) |
| **Remove** | Kicked from the SFU, and any stage grant revoked so rejoining does not restore it |
| **End for all** | Deletes the room, so the audience is not left watching a dead stage |
| Chat / Q&A / raise hand / reactions | Off switches for the audience; the stage keeps them |

Two exemptions are deliberate. Mute-all skips the host — muting yourself with the
"mute everyone" button ends with someone presenting in silence. And an individual
"allow to speak" grant overrides the room-wide self-unmute switch, because mute-all
turns that switch off and the alternative is handing one attendee a dead button.

**Nobody can switch your microphone on.** Not the host, not our API. LiveKit
refuses a server-side unmute unless `room.enable_remote_unmute` is turned on, and
we deliberately leave it off — an API call that opens a microphone in somebody
else's room is not a feature. So the host's options on a silent participant are to
*ask* (a request on the data channel, which their browser answers) or to restore a
permission they had taken away. The roster only ever offers the one that will work.

**A mute that holds.** Muting a published track is not enough on its own: the
participant's own browser can unmute it again a second later, which is exactly what
the button exists to prevent — confirmed against a live SFU before this was
changed. So a host mute also removes the microphone from their grant. That is
enforced by the SFU, not by our UI, so clicking the button, reloading the page and
running a patched client all achieve the same nothing. `mutedByHost` in their
metadata is what keeps the difference visible: they are still a speaker the host
silenced, not an attendee, and the panel offers "allow to speak again" rather than
"promote".

## In the room

Built on `livekit-client` with our own layout rather than the prefab components,
because the responsive behaviour is the feature — the control bar collapses to
glyphs below `sm`, panels dock as a column from `md` and become bottom sheets
below it, and the whole thing is `dvh`-sized so mobile Safari's toolbar does not
push the leave button off screen.

- Speaker and gallery views, pin any tile, screen share auto-focuses
- Chat (public or panelists-only), Q&A with upvoting, raised hands, reactions
- Pre-join device check for publishers; attendees skip it, since they publish
  nothing and a preview would be a click between them and the webinar
- Device switching mid-session, and a publish-resolution picker (360p–1080p)

**Screen sharing** is encoded as a screen, not as a camera: `ScreenSharePresets`
at 15fps and `contentHint: "detail"`, so under bitrate pressure the encoder drops
frames and keeps pixels. A camera preset does the opposite, and the first thing it
throws away is the small text somebody is trying to read. The presenter is never
shown their own capture — sharing a whole screen means the capture contains this
window, and a window playing back its own capture is an infinite corridor that the
audience receives too. They get "You're sharing your screen" instead, which is what
Zoom and Meet do for the same reason.

**Quality**: `adaptiveStream` + `dynacast` + simulcast are on for every role.
Adaptive stream means the SFU sends a layer no larger than the `<video>` element
actually is, so a 240px tile does not pull 720p; dynacast stops sending layers
nobody subscribes to at all. With 500 mostly-idle attendees that is the difference
between paying for what is watched and paying for what is published.

## Recording

Press **Record** in the room. The host and any panelist can start one, the audience
cannot, and one runs at a time — a partial unique index on `recordings` enforces
that, so two people pressing it in the same second cannot both win.

**Everyone is told.** The flag lives in the server's room metadata, not in the
recorder's browser, so an attendee whose browser is doing nothing still sees the REC
indicator and a one-line notice. Consent is not something to leave to the client
that pressed the button.

**Where the bytes come from.** The recording browser composites the stage onto a
canvas — screen share full-frame with the presenters in the corner, or an even grid
— mixes every participant's audio through Web Audio, encodes with `MediaRecorder`
and uploads each chunk as it is produced. Nothing is buffered in the tab: an hour of
720p is gigabytes, and a page that accumulates it crashes before anyone can save it.

That is a deliberate first implementation. It records exactly what a viewer saw,
including the screen share, with no second renderer to keep in step with the room's
layout, and it needs no new infrastructure. The alternative is LiveKit Egress: a
separate service plus Redis plus a headless renderer. The seam is the API, not the
browser — `start / chunks / complete / list / file` is the same surface either way,
so moving to Egress later changes nothing a host sees.

Its cost is stated in the product rather than hidden: recording stops if that tab
closes, and it uses that machine's CPU. Zoom's local recording behaves the same way.

Three details that were bugs before they were features:

- **The tail arrives after `stop()`.** `MediaRecorder` fires its last
  `ondataavailable` on a later task, and Chrome's MP4 muxer holds most of a short
  recording until then. Closing the recording without waiting for `onstop` uploaded
  a 1 kB header, had the real data rejected as "already finished", and produced a
  file nothing could decode.
- **The compositor runs on a timer, not `requestAnimationFrame`.** rAF stops
  completely in a hidden tab — and a presenter switching to the app they are
  demonstrating hides this one. The capture stream keeps emitting frames regardless,
  so with rAF the recording would run full length showing one frozen frame: the
  worst kind of failure, because it looks fine until somebody watches it.
- **Closing the tab closes the recording**, through a `keepalive` request on
  `pagehide`. Otherwise the row stays open until the staleness sweep notices and the
  room shows a recording indicator for a recorder that no longer exists.

Storage is behind an interface with one implementation:

| | |
|---|---|
| `RECORDINGS_BACKEND=disk` | files under `RECORDINGS_DIR`, keyed by uuid, never by anything a person typed |
| `RECORDINGS_BACKEND=s3` | **refused at boot** — the config surface exists, the code does not yet |
| `MAX_RECORDING_MB` | per-recording ceiling, so a forgotten one cannot fill the disk and take the API with it |

Downloads are served with `http.ServeContent`, so range requests work and a
recording can be scrubbed in the browser rather than only played from zero. That one
endpoint is exempt from the API's request timeout, because a forty-minute video on a
hotel connection takes longer than any sane API deadline.

Chat carries the sender's name **in the payload** rather than looking it up from
the participant list — a hidden attendee has no participant record on the
receiving side, so a lookup would render their message as coming from nobody.
Everything arriving on the data channel is untrusted input from another browser,
so `lib/realtime.ts` validates and clamps every field before it reaches React.

## Architecture

```
Browser ──POST /api/…/join──► Go API ─────► Postgres
   │                            │          (is this registration approved?)
   │                            └─mints──► LiveKit JWT (role → VideoGrant)
   │
   └────── WebRTC (media never transits the API) ──────► LiveKit SFU :7880
```

```
api/
├── cmd/server/          entrypoint: config, migrate, seed, graceful shutdown
├── cmd/lkstat/          ops tool: who is in a room, what they publish, who is hidden
├── internal/
│   ├── lk/              LiveKit tokens, rooms, moderation  ← the security core
│   ├── store/           all SQL; embedded migrations
│   ├── auth/            argon2id passwords, HS256 sessions
│   ├── httpx/           JSON, middleware, rate limiting
│   └── api/             handlers + router
└── types/               the wire contract → generates the frontend's types

web/
├── app/
│   ├── host/(portal)/   host portal pages, with nav + sidebar chrome
│   └── host/[id]/room/  deliberately OUTSIDE (portal): a full-screen room must
│                        not inherit a layout — see the comment in that layout
├── components/room/     the WebRTC stage, control bar, panels, host controls
└── lib/api-types.ts     GENERATED by tygo — do not edit
```

### Types cannot drift

`api/types/types.go` is the single source of truth. `make types` regenerates
`web/lib/api-types.ts`; `make types-check` fails if they diverge, so rename a Go
field and the frontend stops compiling instead of breaking during a live session.

### Nothing user-facing is hardcoded

The product name, the public URL share links are built from, the attendee ceiling
and whether signup is open all come from `GET /api/config`. Time zones come from
`Intl.supportedValuesOf('timeZone')` — the platform's copy of the IANA database,
not a list of four cities that is wrong for most of the world. Topic tags are
free text with suggestions drawn from what already exists. Avatar colours are
hashed from the account's email at fixed saturation and lightness, so every
account has one without a palette to maintain in two languages.

## Testing

```bash
make test        # 58 Go tests (unit + integration) + tsc + eslint
make test-e2e    # 104 checks across three real browsers over WebRTC
```

`make test-e2e` launches three isolated Chrome instances with synthetic
camera/mic, registers two attendees through the real UI, joins all three to one
room, then asks the **SFU** — not the UI — whether the permissions landed:

```
✅ host IS publishing at least one track — AUDIO/MICROPHONE,VIDEO/CAMERA
✅ NO attendee in the room has publish permission
✅ EVERY attendee is hidden at the SFU
✅ the host is NOT hidden (the audience must see them)
✅ attendee panel does NOT name the other attendee
✅ host CAN see the hidden attendees (server-side roster)
✅ the HOST is still unmuted after mute-all
✅ attendees already connected became visible at the SFU
✅ the presenter is NOT shown their own capture (no mirror)
✅ attendee is receiving the shared screen as decoded frames — video=1920x1080
✅ the grant is MICROPHONE ONLY, not a full stage grant
✅ clicking the microphone does NOT get them back on air
✅ the audience is shown the recording indicator
✅ the file decodes and plays — {"w":1280,"h":720,"at":2.45}
```

It drives the host's real panel for the moderation flow rather than calling the
endpoints, because half of what a click does — lowering the raised hand on the
attendee's own screen — happens over the data channel and no endpoint can do it.

Integration tests need `TEST_DATABASE_URL` and skip without it.

## Deploying

One server, six containers, automatic TLS — **[DEPLOY.md](DEPLOY.md)** is the
runbook.

```bash
cp .env.prod.example .env.prod   # DOMAIN, ACME_EMAIL and three generated secrets
make deploy                      # build and start the whole stack
```

Caddy terminates TLS and routes `/api/*` to the API and everything else to Next, so
the app is a single origin: the session cookie is first-party and there is no CORS
preflight on the join path. The SFU's signalling sits at `sfu.$DOMAIN`; its media
ports bypass the proxy entirely, because RTP is UDP and a reverse proxy cannot carry
it.

```bash
make build    # static linux/amd64 binary
make docker   # distroless image, no shell, runs as nonroot
```

Copy `.env.example` to `.env` and fill it in. The API **refuses to start** with
`APP_ENV=production` if `SESSION_SECRET` or `LIVEKIT_API_SECRET` are still the
development defaults, if `COOKIE_SECURE` is false, if `LIVEKIT_URL` is not
`wss://`, or if `JOIN_RATE_PER_MIN` is below `MAX_ATTENDEES`.

Three things that will bite you in production:

- **`LIVEKIT_URL` must be `wss://`.** A `ws://` SFU on an `https://` page is
  blocked as mixed content, and the failure looks like a hang, not an error.
  Now checked at boot.
- **Publish LiveKit's UDP range** (50000–50060) plus TCP 7881. Without UDP you
  connect and see black video; without the TCP fallback, roughly 15% of corporate
  attendees can't join at all. You also need **coturn** in front for those users.
- **Rate limits are per IP, and an audience shares one.** A corporate audience
  arrives from a single egress address, so a join limit sized for one person
  retrying locks out the building. Hence the boot-time floor.

### Google Cloud Run (API only)

Current managed topology (Cloudflare Workers + Cloud Run + Supabase + LiveKit
Cloud): [`docs/DEPLOYMENT-TOPOLOGY.md`](docs/DEPLOYMENT-TOPOLOGY.md).

Scaffolding lives under `deploy/`. Project default: `ai-project-490516`, region
`asia-south1` (Mumbai), Artifact Registry repo `webcast`.

**Postgres for production:** prefer **Supabase** (`deploy/SUPABASE.md`). Local
`docker-compose` / Homebrew Postgres stays for offline development. Use a
Supabase **direct** URI with `sslmode=require`. Transaction pooler is optional
and needs `default_query_exec_mode=simple_protocol` for pgx.

```bash
cp deploy/cloudrun.env.example deploy/cloudrun.env   # fill secrets (gitignored)
# DATABASE_URL=postgres://postgres:…@db.<ref>.supabase.co:5432/postgres?sslmode=require
make migrate DB_URL="$DATABASE_URL"                  # one-shot schema (also runs on API boot)
./deploy/cloudrun-deploy.sh --build-only             # image → Artifact Registry
./deploy/cloudrun-deploy.sh                          # build + Cloud Run deploy
```

Required env for a live service: `DATABASE_URL`, `SESSION_SECRET` (≥32 bytes),
and LiveKit via `LIVEKIT_PROJECTS` or legacy `LIVEKIT_URL` + `LIVEKIT_API_KEY` +
`LIVEKIT_API_SECRET`. Set `RECORDINGS_ENABLED=false` on Cloud Run until you have
writable storage. The API listens on Cloud Run's `PORT` when `ADDR` is unset.

**GitHub Actions:** `.github/workflows/cloudrun-deploy.yml` is the single Cloud
Run API deploy workflow (the old `deploy-api.yml` duplicate was removed). It
supports:

- **Manual:** `workflow_dispatch` from the Actions tab
- **Auto:** push to `main` when `api/**`, `deploy/cloudrun-deploy.sh`,
  `deploy/cloudrun.env.example`, or the workflow file itself change

Set repository secrets `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
(or `LIVEKIT_PROJECTS`), plus `DATABASE_URL` (Supabase), `SESSION_SECRET`, and
`GCP_SA_KEY` (deploy service-account JSON). Optionally set `ADMIN_EMAILS` and
`ADMIN_PASSWORD` (≥10 chars) so production boots an admin account on a fresh DB.
Do not commit real values — placeholders only in `deploy/cloudrun.env.example`.

```bash
gh secret set DATABASE_URL -R netesh3/webinar   # paste Supabase URI when prompted
```

LiveKit media still needs UDP/TCP outside Cloud Run (self-hosted SFU or LiveKit
Cloud). Leave `CLOUD_SQL_INSTANCE` unset when using Supabase.

## Scaling past 500

500 concurrent attendees on pure WebRTC is ~1 Gbps of egress from one SFU node —
about the ceiling for a single unmetered 1 Gbps box. Beyond that, don't add SFU
nodes for the audience: add the **LL-HLS tier** (LiveKit Egress → CDN) and leave
the stage on WebRTC. `PLAN.md` has the cost model — the short version is that
10,000 HLS viewers cost about $34/hour of CDN, and the same audience on WebRTC
would need roughly 40 servers.

## What isn't built

Honest list, so nothing here is a surprise:

- **No email.** Registration returns the join link in the page and on the
  account; nothing is sent. No SES, no reminders, no follow-ups. The UI does not
  claim otherwise.
- **Recording is client-side**, done by the browser of whoever pressed record. It
  works, the file is downloadable and playable, and it stops if that tab closes.
  Server-side capture (LiveKit Egress) is the next step and would remove that
  caveat; `autoRecord` is stored but nothing starts a recording automatically yet.
- **S3 for recordings** is a config value the API refuses rather than a backend.
  Files live on the API's disk until it exists.
- **Polls** — the option is stored; the feature is not built. Q&A, raise hand,
  reactions and chat all are.
- **Payments** — `priceUsd` is displayed; no Stripe, and nothing is charged.
- **Simulive** — schedulable as a kind, but a recording cannot yet be played back
  into a session.
- **Chat has no history.** It rides a data channel, so a late joiner sees
  messages from their join onwards. The UI says so rather than looking broken.
- **Rate limiting is in-memory**, so it is per-node. Move it to Redis before
  running more than one API instance or the effective limit multiplies.
- **`mock-ui/`** is the original static design mock, kept for reference. The real
  app is `web/`.
