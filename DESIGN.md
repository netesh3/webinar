# Webinar Liv — design

A self-hosted webinar product: one host, a few panelists, up to 500 attendees who
watch and ask questions. Zoom Webinars' shape, not Zoom Meetings' — the asymmetry
between "a handful of publishers" and "hundreds of subscribers" is the single fact
that determines the architecture.

Four documents in one, in the order they are useful:

1. [High-level design](#1-high-level-design) — components, and why each exists
2. [Low-level design](#2-low-level-design) — data, API, permissions, realtime, recording
3. [Deployment model](#3-deployment-model) — local, one VPS, and the EC2 host in use
4. [End-to-end flows](#4-end-to-end-flows) — including how media actually connects

This document holds the **rationale** — why each decision was made and what it cost.
For the current shape at a glance, with diagrams, start at
[`ARCHITECTURE.md`](ARCHITECTURE.md); for capacity arithmetic, [`docs/CAPACITY.md`](docs/CAPACITY.md).

---

## 1. High-level design

### 1.1 Components

```
                            ┌──────────────────────────────────┐
   browser                  │            one origin            │
   ┌──────────────┐         │                                  │
   │  Next.js UI  │◄────────┤  /            → web  :3000       │
   │              │  HTTPS  │  /api/*       → api  :8080       │
   │  livekit-    │◄────────┤  /sfu/*       → sfu  :7880  (wss)│
   │  client SDK  │         └──────────────────────────────────┘
   │              │
   │              │  RTP / SRTP over UDP (or TCP fallback)
   │              │◄─────────────────────────────────────┐
   └──────────────┘                                      │
                                                    ┌────┴─────┐
   ┌─────────┐      ┌─────────────┐                 │ LiveKit  │
   │   web   │─────►│     api     │◄───── room API ─┤   SFU    │
   │ Next.js │ SSR  │     Go      │  (twirp/HTTP)   └──────────┘
   └─────────┘      └──────┬──────┘
                           │
                    ┌──────┴──────┐        ┌──────────────┐
                    │  Postgres   │        │  recordings  │
                    │             │        │  disk → S3   │
                    └─────────────┘        └──────────────┘
```

Five processes. Everything about the product is decided by which of them is
authoritative for what.

| Component | Responsibility | Explicitly *not* responsible for |
|---|---|---|
| **web** (Next.js) | Rendering, and reporting what the server told it | Any authorization decision. It hides buttons; it never grants anything |
| **api** (Go) | The authority. Accounts, webinars, registrations, and **minting every LiveKit token** | Carrying media. It never sees a byte of audio or video |
| **sfu** (LiveKit) | Forwarding media, and *enforcing* what a token says a participant may publish | Deciding who may do what. It only verifies the grant the API signed |
| **Postgres** | Durable truth: accounts, schedules, registrations, stage grants, recording rows | Live state (who is connected right now) — that is the SFU's |
| **storage** | Recording bytes | — |

### 1.2 The decisions that matter

**An SFU, not a mesh.** With 500 attendees a peer-to-peer mesh is 250,000
connections. An SFU means each publisher uploads once and the server fans out. It
also means the server is the only place that can *enforce* who publishes, which is
what makes host controls real rather than cosmetic.

**Permissions live in the token, and the SFU enforces them.** The API signs a
LiveKit JWT whose `VideoGrant` says exactly which track sources a participant may
publish. An attendee's token permits none. When a host allows someone to speak, the
API mints a new grant containing `MICROPHONE` and pushes it to the SFU. The browser
cannot bypass this: calling `setMicrophoneEnabled(true)` directly returns *"failed
to publish track, insufficient permissions"*. This is the security core of the
product and §2.3 covers it in detail.

**One origin.** The reverse proxy sends `/api/*` to the API and everything else to
Next, so the session cookie is plainly first-party and there is no CORS preflight
on the join path when 500 people arrive in the same minute. The browser bundle
contains no hostname at all — `NEXT_PUBLIC_API_BASE` is built empty so every request
is relative and one image works for any domain.

**Media never touches the proxy.** RTP is UDP; a reverse proxy cannot carry it. The
SFU publishes its own ports and they must be reachable directly. This is the single
most common source of "it connects and the video is black", and §3.3 and §4.5 are
mostly about it.

**Recording is client-side, deliberately.** The browser of whoever presses record
composites the stage onto a canvas, mixes audio, and uploads chunks to the API. No
extra infrastructure, and it works today. The cost is that it stops if that tab
closes. Server-side capture (LiveKit Egress) is the upgrade path, and the storage
interface already has the seam for it.

**Postgres holds session controls, not memory.** "Attendees are hidden" has to
survive an API restart and apply to someone who joins ten minutes later. Controls
are rows, mirrored into SFU room metadata on every change — which is how 500
browsers learn about a toggle without polling.

### 1.3 Scale envelope

Only the host and panelists publish, so the load is **egress**: 500 × 2.25–3 Mbps ≈
**1.1–1.5 Gbps**, against ~12 Mbps of ingress. The ceiling is bandwidth, not CPU —
forwarding is cheap and scales with publishers, not subscribers. Measured numbers,
per-subscriber breakdown and instance sizing are in
[`docs/CAPACITY.md`](docs/CAPACITY.md); the instance in use today is undersized for
500 by roughly five times.

- `MAX_ATTENDEES` (default 500) is enforced by the API *and* by the SFU: rooms are
  created with `max_participants`, and `auto_create: false` means no token can
  conjure a room that sidesteps the limit.
- `JOIN_RATE_PER_MIN` must be ≥ `MAX_ATTENDEES` — the API refuses to boot otherwise.
  A corporate audience arrives from one egress IP, so a limit sized for one person
  retrying locks out the whole building.
- **More SFU nodes do not make one webinar bigger.** OSS LiveKit assigns a *room* to a
  *node* and does not split a room across nodes, so Redis plus N nodes buys concurrent
  *sessions*. For one big session the answer is a larger instance; past that, LL-HLS
  for the audience.

---

## 2. Low-level design

### 2.1 Data model

Ten tables, eight migrations, all embedded in the API binary and applied at boot —
so a container cannot start against a schema it was not built for.

```
users ──────────┬──< webinars ──┬──< webinar_panelists >── users
                │               ├──< custom_questions
                │               ├──< registrations
                │               ├──< webinar_stage_grants
                │               ├──< recordings
                │               ├──< polls ──< poll_votes
                │               └──< chat_messages
                └──< registrations
```

| Table | Holds | Notes |
|---|---|---|
| `users` | Accounts. `can_host` is a capability on an ordinary account | argon2id password hashes. Hosting is not a separate account type: the same person registers for others' webinars and runs their own |
| `webinars` | Schedule, options, and live `controls` | `slug` is the URL id; `status` ∈ draft/scheduled/live/ended |
| `webinar_panelists` | Invited co-presenters | A panelist needs no hosting capability — a guest speaker must be able to reach a room they were invited to |
| `custom_questions` | Extra registration fields | |
| `registrations` | One row per attendee. `join_key` is the credential | Registering needs no account; the key is kept in the browser |
| `webinar_stage_grants` | Who the host promoted, and how | The **durable** half of host control — see §2.4 |
| `recordings` | One row per recording | `status` ∈ recording/ready/failed, with a **partial unique index** enforcing one active recording per webinar |
| `polls` | Polls and quizzes. A quiz is a poll with a right answer | `state` ∈ draft/open/closed, with a partial unique index enforcing one open poll per webinar |
| `poll_votes` | One row per person per poll | Primary key `(poll_id, identity)` |
| `chat_messages` | The transcript, text and images | Primary key is the **client's** message id; `seq bigserial` is the sync cursor |

Four constraints do work no handler can:

```sql
CREATE UNIQUE INDEX recordings_one_active_idx ON recordings (webinar_id)
    WHERE status = 'recording';
CREATE UNIQUE INDEX polls_one_open_per_webinar ON polls (webinar_id)
    WHERE state = 'open';
PRIMARY KEY (poll_id, identity)   -- poll_votes
PRIMARY KEY (id)                  -- chat_messages, id supplied by the client
```

Two people pressing Record at once, or one host double-clicking Launch, is a race the
database refuses rather than one the application hopes about — checking first leaves a
window where two requests both find nothing. The same reasoning covers the other two:
one vote each, and a message resent because its response was lost collides and is
ignored, so a reconnecting client cannot render a line twice.

### 2.2 API surface and authorization boundaries

Authorization is expressed as router structure, not as `if` statements scattered
through handlers. Every route's protection is visible from its position in the tree.

```
/api
├── public — no credential at all
│   ├── GET   /config                              branding, limits, share base
│   ├── GET   /webinars, /webinars/{slug}
│   ├── POST  /webinars/{slug}/register            rate limited
│   ├── POST  /webinars/{slug}/join                join key OR session
│   └── POST  /registrations/lookup                keys held in this browser
│
├── in-room — join key OR session; the caller's role decides what comes back
│   ├── POST  /webinars/{slug}/say                 the relay: chat, Q&A, hands, reactions
│   ├── GET   /webinars/{slug}/chat?since={seq}    backlog and reconnect sync
│   ├── POST  /webinars/{slug}/chat/image          store bytes AND create the message
│   ├── GET   /webinars/{slug}/chat/media/{id}
│   ├── GET   /webinars/{slug}/polls               audience view: no tallies, ever
│   └── POST  /webinars/{slug}/polls/{id}/vote
│
├── auth
│   ├── POST  /auth/signup, /auth/login            separate rate buckets
│   └── requireUser:  GET/PATCH /auth/me
│
├── /me            requireUser
│   └── GET   /registrations
│
└── /host          requireUser
    ├── POST  /webinars/{slug}/join                owner OR panelist — NOT requireHost
    ├── GET   /stage                               the caller's own rows only
    │
    ├── requireStage   (the host AND the panelists)
    │   └── recordings: list, start, chunks, complete, file, delete
    │
    └── requireHost    (the hosting capability)
        ├── GET/POST  /webinars
        ├── PATCH     /registrations/{id}
        └── /webinars/{slug}   requireOwnership
            ├── GET/PATCH/DELETE /
            ├── POST  /start, /end
            ├── PATCH /controls
            ├── registrants: list, csv, approve-all
            ├── panelists: add, remove
            ├── participants: list, mute-all,
            │                 {identity}/mute, {identity}/stage, DELETE {identity}
            ├── chat: GET (transcript, JSON or CSV), GET /chat/stats
            └── polls: GET/POST, {id}/open, {id}/close, DELETE {id}
```

Three subtleties that are easy to get wrong and were:

- **`/host/webinars/{slug}/join` and `/host/stage` are `requireUser`, not
  `requireHost`.** A panelist is invited by name to somebody else's webinar. Asking
  them to enable hosting first means a guest speaker cannot reach the room they were
  invited to. Both handlers authorize themselves instead.
- **Recording is `requireStage`, not `requireOwnership`.** A panelist presenting
  their own section should be able to record it. Note what `requireStage` actually
  wants, though: an **account** on the stage roster. An attendee the host promoted
  publishes exactly like a panelist and has no account, so they are refused here —
  which is why `JoinResponse.canRecord` is decided by the server and echoed, rather
  than inferred client-side from publish permission. Inferring it offered a promoted
  attendee a button whose every request came back 401.
- **Rate limiting is per-IP and in-memory**, therefore per-process. Two API replicas
  double the effective limit. That is why the deployment runs one, and why moving
  the limiter to Redis is a prerequisite for scaling out.

### 2.3 The permission model

This is the part worth reading twice, because a plausible-looking mistake here is a
silent security hole rather than a bug.

LiveKit's `VideoGrant` has two traps:

- The permission fields are `*bool`. **`nil` means grant everything.**
- `CanPublishSources` is a list, and **an empty list means all sources.**

So removing the last allowed source must set `CanPublish: false` — emitting an empty
list grants *more* than intended. That is the entire content of this function:

```go
func stageSources(spec Spec) (sources []livekit.TrackSource, canPublish bool) {
	switch {
	case spec.AudioOnly && spec.MutedByHost:
		return nil, false                       // nothing at all
	case spec.AudioOnly:
		return []livekit.TrackSource{livekit.TrackSource_MICROPHONE}, true
	case spec.MutedByHost:
		return []livekit.TrackSource{           // camera and screen, no mic
			livekit.TrackSource_CAMERA,
			livekit.TrackSource_SCREEN_SHARE,
		}, true
	default:
		return nil, true                        // full publisher
	}
}
```

Three channels carry state, and each is chosen for a reason:

| Channel | Carries | Why this channel |
|---|---|---|
| **Token grant** | What you may publish | The SFU enforces it. Not advisory |
| **Participant metadata** | `role`, `audioOnly`, `mutedByHost`, `promoted` | Per-person, and the UI must react — the client subscribes to `ParticipantMetadataChanged` |
| **Room metadata** | Session controls + `recording` | One broadcast reaches 500 browsers without polling |

`Hidden: true` on an attendee token is SFU-enforced invisibility — an attendee is
invisible to every other client, not merely filtered out of a list by our own
JavaScript. (Server-side `ListParticipants` still returns hidden participants, which
is how the host roster works.)

**`CanPublishData: false` on an attendee token** is the same idea applied to the
interactive layer, and it is checked in `ParticipantImpl.onDataMessage` — a patched
client cannot get around it. This is what makes the chat relay in §2.5 possible: the
audience has exactly one route for a message, so the server can decide who receives it
and write it down on the way past. It is also why `permissionFor` is role-aware; giving
every role the same data grant for convenience would have handed the audience a
broadcast channel.

**Two metadata flags exist only because a permission cannot distinguish two cases:**

- `mutedByHost` — an attendee and a silenced speaker both lack a microphone. Only
  metadata says which, and without it the UI cannot offer "allow to speak again".
- `promoted` — a promoted attendee and a scheduled panelist hold *identical*
  permissions, and the difference decides whether the room-wide "panelists may not
  unmute themselves" switch applies to them. Without it, bringing someone on stage
  after a *Mute everyone* gave them a working camera and a dead microphone button,
  because `allowUnmute` stays latched off.

**One empirical constraint:** LiveKit refuses server-side *unmute* unless
`room.enable_remote_unmute` is set — the error is
`failed_precondition: remote unmute not enabled`. It is deliberately left off, so
"allow to speak" grants the *permission* and the participant clicks Unmute
themselves. The sentinel `ErrRemoteUnmute` is treated as success by the handler so
the host's action reports honestly.

### 2.4 Host control: the speaking lifecycle

The requirement that shapes this: *a participant who has been muted by the host
cannot unmute themselves until the host allows speaking again.* A UI-only mute fails
that within seconds.

```
                 ┌─────────────┐
                 │  AUDIENCE   │   token: CanPublish=false, Hidden=true
                 └──────┬──────┘
             raise hand │  (data message, kind="hand")
                        ▼
                 host sees "X wants to speak"
                        │
      ┌─────────────────┼──────────────────┐
      │ allow to speak  │ dismiss          │ ignore
      ▼                 ▼                  ▼
┌───────────┐    lower-hand msg        (nothing)
│ SPEAKING  │    audioOnly=true, mutedByHost=false
│           │    grant: [MICROPHONE]
└─────┬─────┘    participant clicks Unmute themselves
      │
      │ host mutes
      ▼
┌──────────────┐   MuteTrack + persist muted_by_host=true
│ SILENCED     │   grant: CanPublish=false  ← the latch
│              │   participant sees "You have been muted by the host"
└─────┬────────┘   and *cannot* unmute: the SFU refuses the publish
      │
      │ host: "allow to speak again"   → clears the latch, back to SPEAKING
      │ host: "remove speaker permission" → back to AUDIENCE
      ▼
```

The latch is a column, `webinar_stage_grants.muted_by_host`, so it survives a page
reload and an API restart: `handleHostJoin` and `handleAttendeeJoin` both restore it
when minting a token. A host who promoted someone earlier gets them back on stage
after a reconnect **with the same scope** — "allowed to speak" does not silently
become a camera, and a host mute is not lifted by a refresh.

Ordering matters and is asymmetric: muting is *MuteTrack then latch*; unmuting is
*latch then MuteTrack*. Either way the participant is never briefly able to publish.

### 2.5 Realtime channels

Beyond media, the SFU's data channel carries the interactive layer. Ten message kinds:

```
chat  question  upvote  answered  hand  lower-hand  hands-cleared  reaction
unmute-request  polls-changed
```

All are parsed defensively on receipt — an unknown or malformed message is dropped, not
thrown. `decode()` in `web/lib/realtime.ts` is the single trust boundary: every field is
validated and every string clamped before anything reaches React, and kinds only the
stage may send (`lower-hand`, `hands-cleared`) are rejected from an attendee.

`hand` and `lower-hand` are a pair: the participant raises, and the host lowering it
publishes `lower-hand` so the participant's own UI reflects the dismissal.

Two kinds do **not** originate from a participant, and the reason is the permission
model rather than convenience:

- **`chat` is sent only by the server.** Attendees hold `canPublishData: false`, so they
  POST to `/say` and the API relays via `SendData` with `destinationIdentities`. That is
  what makes a panelists-only message enforceable — it is never delivered to an
  attendee's browser, so nothing is trusted to hide it — and it is what makes the
  transcript possible. The stage relays through the same endpoint: an HTTP round trip on
  the same host costs milliseconds, and a transcript missing everything the presenter
  said is not a transcript.
- **`polls-changed` is a bare nudge with no payload.** Every client then re-reads *its
  own* endpoint, because the host's view carries tallies and correct answers that the
  audience must not receive. Putting a poll in the packet would broadcast one view to a
  room containing both.

`unmute-request` goes the other way, from the stage to one participant: a server cannot
start somebody's microphone, so "please unmute" is a request, not an action.

### 2.6 Recording pipeline

```
browser (whoever pressed Record)
  │
  │ 1. VideoSources: hidden 1×1 <video> elements per publisher
  │    (in the DOM, not detached — a detached element does not decode)
  │ 2. paint() → canvas 1280×720 @ 25fps, driven by setInterval
  │    NOT requestAnimationFrame: rAF halts in a hidden tab, which would
  │    record a frozen frame at full duration. setInterval only throttles.
  │ 3. AudioMixer: MediaStreamAudioDestinationNode mixes every publisher
  │ 4. MediaRecorder over canvas.captureStream() + the mixed audio
  │
  ▼ POST /recordings                    → row, status=recording, storage key
  ▼ POST /recordings/{id}/chunks        every 5s, ≤32 MB each, appended
  ▼ POST /recordings/{id}/complete      status=ready, size, duration
```

Two details that were bugs first:

- **`stop()` must await `onstop`.** Chrome's MP4 muxer batches media data and
  flushes on stop, so `complete()` sent immediately loses the tail — a 15-second
  recording came out 1247 bytes and undecodable. The recorder now calls
  `requestData()`, `stop()`, and waits for `onstop` with a 10s failsafe.
- **A `pagehide` handler sends a `keepalive` complete request**, so closing the tab
  finalises the row instead of leaving it `recording` forever. `staleAfter = 90s`
  reaps anything that still slips through.

Storage is behind an interface, which is the S3 seam:

```go
type Store interface {
	Append(ctx, key string, r io.Reader) (int64, error)
	Open(ctx, key string) (io.ReadSeekCloser, int64, error)
	Delete(ctx, key string) error
	Describe() string
}
```

`Disk` write-probes its root at boot and the API refuses to start if it cannot write
— better than discovering it when somebody presses Record. `RECORDINGS_BACKEND=s3`
is a config value the API deliberately **refuses** until the backend exists:
pretending to store recordings is worse than not offering to.

Downloads go through `http.ServeContent` for range support, with a write deadline,
and `Content-Disposition` exposed via CORS.

### 2.7 Configuration

Read once at boot and **validated**, so a misconfiguration is a startup failure with
a message naming the variable, not a webinar that behaves oddly. Notable rules:

- `LIVEKIT_URL` must be `wss://` outside development. A `ws://` SFU on an `https://`
  page is blocked as mixed content and presents as a hang, not an error.
- `LIVEKIT_HTTP_URL` is where *this process* reaches the room API. It defaults to
  `LIVEKIT_URL` with the scheme swapped, which is right when both sides share one
  address — and wrong in Kubernetes, where it would send every mute out to the
  internet and back. Set it to the in-cluster Service address.
- `MIN_PASSWORD_LENGTH` floors at 10 outside development, 4 inside. A relaxed floor
  cannot follow a deployment into production.
- `SESSION_SECRET` must be ≥32 bytes and not the dev default; `COOKIE_SECURE` must
  be true; `JOIN_RATE_PER_MIN` ≥ `MAX_ATTENDEES`.
- `SEED_DEV` only ever runs in development. A known password in a real database is a
  breach.

---

## 3. Deployment model

Three shapes, same images.

### 3.1 Local development

```
./start.sh        postgres + redis + livekit in compose; api and web on the host
```

`ws://localhost:7880`, relaxed password floor, demo accounts seeded when `users` is
empty. Media is loopback, so none of §4.5 applies.

### 3.2 One VPS — the intended production shape

```
                        :443  ┌─────────┐
   browser ────────────────── │  caddy  │  automatic TLS
                              └────┬────┘
                    /api/*  ┌──────┴───────┐  everything else
                       ┌────▼────┐    ┌────▼────┐
                       │   api   │    │   web   │
                       └──┬───┬──┘    └─────────┘
              recordings  │   └──►┌──────────┐
                 volume ◄─┘       │ postgres │
                                  └──────────┘

   sfu.DOMAIN :443 ── caddy ──► livekit :7880          signalling (wss)
   browser ──────────────────► livekit :50000-50060/udp, :7881/tcp   media
```

Six containers, one compose file, two DNS records. The SFU gets its **own hostname**
and publishes its media ports directly — no load balancer between the browser and
the SFU, which is why the media path here is simple and reliable.

Requirements: 2 vCPU / 4 GB is plenty for the software; **unmetered 1 Gbps is the
number that matters** — a 500-person webinar moves ~450 GB an hour. Ports 80, 443,
7881/tcp and 50000–50060/udp open.

### 3.3 One EC2 instance — the current deployment

`i-03bf2bc82b85e62b7`, a `t3.medium` in a **public** subnet with an Elastic IP. This is
§3.2 on rented hardware: the same compose file, the same five containers, one address.

```
   browser
     │  https://3.82.201.244.sslip.io          app + API
     │  wss://sfu.3.82.201.244.sslip.io        signalling
     ▼
  ┌────────────────────── EC2, Elastic IP 3.82.201.244 ──────────────────────┐
  │  caddy :443/:80  ──► web :3000 · api :8080 · livekit :7880 (signalling)  │
  │  postgres :5432 (pgdata volume) · recordings volume                      │
  └─────────────────────────────────────────────────────────────────────────┘
     ▲
     │  50000-60060/udp · 7881/tcp · 3478/udp        media, straight to the host
   browser
```

`sslip.io` resolves `<ip>.sslip.io` to that IP, so Let's Encrypt issues real
certificates with no DNS to own. `livekit` runs `network_mode: host` — on a bridge it
advertises `172.17.0.1` as a candidate, which no browser can reach, and ICE burns real
time failing it first.

| Concern | Decision |
|---|---|
| **No load balancer** | The reason this is not on Kubernetes. See below |
| **Public subnet, Elastic IP** | An internet gateway does symmetric 1:1 NAT, so the host answers from the address it was asked on. That property is the whole media path |
| **Access** | SSM Session Manager, no SSH key on the instance. Images build locally for `linux/amd64` and push to ECR `webcast-temp` |
| **Rollout** | `--no-deps web` leaves Postgres and the SFU running, so a frontend deploy does not disconnect a live session. Editing `livekit.yaml` needs an SFU restart, which does |
| **Config validation** | LiveKit rejects unknown keys outright and refuses to boot. Validate in a throwaway container before deploying — `limit.num_cpus` looked plausible and does not exist in v1.9 |
| **Storage** | Named volumes. Accounts and recordings survive a redeploy, unlike the EKS attempt below |
| **Capacity** | Undersized for 500 by ~5×, on egress bandwidth. [`docs/CAPACITY.md`](docs/CAPACITY.md) has the arithmetic |

#### Why not Kubernetes: the EKS attempt

An earlier deployment ran in namespace `platform` on cluster `agent-fabric-dev`, mounted
on a path of a hostname another application owned. It has been torn down. Two findings
from it are worth keeping, because they will recur for anyone who tries again:

- **Media cannot go through an AWS NLB.** UDP target groups force `preserve_client_ip`
  on and it cannot be disabled, so the SFU replies directly to the browser and those
  replies leave via the NAT gateway with the wrong source address. Browsers discard them.
  Measured browser-side as `tx=751140 rx=0`: a connection that looks established and
  carries nothing. TCP 7881 worked, which made the failure look intermittent rather than
  structural.
- **A service mesh sidecar breaks the SFU.** Istio intercepts inbound TCP 7881 — that is
  browser media — and under STRICT mTLS rejects it. Injection has to be off, plus
  `DestinationRule` `tls: DISABLE`.

The other costs were incidental but real: `basePath` baked into the image at build time,
route ordering inside a VirtualService another team owned, Envoy prefix-rewrite slashes,
and a `permissions-policy: camera=(), microphone=()` header on the shared hostname that
denies `getUserMedia` outright.

---

## 4. End-to-end flows

### 4.1 Host: schedule → start → join

```
host    POST /api/auth/login                    → session cookie (HS256; SameSite=None+Secure in prod, Lax locally)
host    POST /api/host/webinars                 → row, slug, webinarId
host    POST /api/host/webinars/{slug}/start
          api → SFU  CreateRoom(max_participants, empty_timeout, metadata)
          api → SFU  UpdateRoomMetadata(controls + recording state)
          api → db   status = live
host    POST /api/host/webinars/{slug}/join
          api        stageRole(slug, userID) → host
          api        mint token: roomAdmin, roomJoin, CanPublish=true, Hidden=false
          →          { token, url: wss://…/sfu, identity: user_<id>, role: host }
browser  livekit-client connect(url, token)     → §4.5
```

`auto_create: false` matters here: the room is created by the API, which is what
makes the attendee ceiling enforceable rather than advisory.

### 4.2 Attendee: register → join

```
attendee GET  /api/webinars/{slug}              → public detail
attendee POST /api/webinars/{slug}/register     → { joinKey, state }
                                                  joinKey stored in localStorage
attendee POST /api/webinars/{slug}/join { joinKey }
           api  resolveRegistration(key or session)
           api  reject unless state == approved
           api  reject if ended/draft/locked
           api  ensureRoom, then ParticipantCount ≥ limit → room_full
                (live occupancy, not registration count: registrations run 3-4×
                 the people who show up, so counting rows turns people away
                 while the room is half empty)
           api  identity = att_<joinKey>, restore any stage grant
           api  mint token: CanPublish=false, CanPublishData=false,
                            Hidden=<controls.hideAttendees>
attendee GET  /api/webinars/{slug}/chat?since=0  → the conversation so far
attendee GET  /api/webinars/{slug}/polls         → any open poll → pop-up
```

No account is needed anywhere in this path. The join key *is* the credential, and it is
also what identifies the voter and the chat sender — `identity` is derived from it
server-side, never read from a request body.

`since=0` on the backlog is the same endpoint a reconnect uses with a real cursor, so
one code path cannot disagree with itself about what this viewer may see. Overlap with
the live stream is expected and de-duplicated by message id: a cursor cannot be advanced
and a socket drained in the same instant.

### 4.3 Speaking request

```
attendee  data message  {kind:"hand", raised:true}
host UI   "Rahul wants to speak"  →  Allow to speak
host      POST /api/host/webinars/{slug}/participants/{identity}/stage
                                    {audioOnly:true}
            api → db   stage grant: granted, audio_only, muted_by_host=false
            api → SFU  UpdatePermissions: CanPublishSources=[MICROPHONE]
            api → SFU  UpdateMetadata: role=panelist, audioOnly=true
            api        data message {kind:"lower-hand"}
attendee  sees "The host has invited you to speak", clicks Unmute
```

Then the mute latch and removal, per the state machine in §2.4.

### 4.4 Recording

```
host/panelist  POST   /recordings                → id, storage key, row=recording
                                                   room metadata: recording=true
               POST   /recordings/{id}/chunks     every 5s while running
               POST   /recordings/{id}/complete   after awaiting MediaRecorder.onstop
later          GET    /recordings                 list on the webinar's page
               GET    /recordings/{id}/file       ranged download / inline playback
```

`FinishActiveRecordings` runs when the webinar ends, so ending a session cannot leave
a row stuck in `recording`.

### 4.5 Media establishment — read this before debugging

Everything above is HTTP and either works or returns an error. Media is different:
it negotiates, and it fails *quietly*. This is the sequence, with the failure mode
at each step.

```
 1. signalling      browser ──wss──► ALB ──► envoy ──► livekit:7880  /rtc/v1
                    fails as: page loads, "Connecting…" forever
                    look at: gateway access log, code should be 101

 2. candidates      SFU offers, from rtc.node_ip:
                      <node_ip>:7882 udp host      ← the good path
                      <node_ip>:7881 tcp host      ← fallback, ~15% of corporate
                    fails as: no UDP candidate at all if udp_port is unset —
                              LiveKit falls back to its 50000-60000 default range,
                              which no load balancer here forwards
                    look at: "starting LiveKit server" boot line, rtc.portUDP

 3. ICE checks      browser ──STUN──► SFU        (must work)
                    SFU     ──STUN──► browser    (must ALSO work)
                    fails as: 3 minutes of "connecting", then it works over TCP
                    look at: "ICE candidate pair stats" —
                             requestsSent/responsesReceived asymmetry

 4. DTLS            subscriber transport: SFU is the DTLS **server** (answers)
                    publisher  transport: SFU is the DTLS **client** (initiates)
                    fails as: ATTENDEES CONNECT AND HOSTS DO NOT
                    look at: "connect timeout after ICE connected", transport=PUBLISHER

 5. SRTP            media flows
                    fails as: connected, participant visible, video black
```

**Step 3 and 4 are where this deployment has been broken, and the asymmetry in
step 4 is the diagnostic that identifies it.** If attendees work and hosts do not,
the server→browser direction is failing: the subscriber transport only ever answers,
so it survives a one-way path, while the publisher transport must send the first
DTLS packet and cannot.

The cause was the media NLB. An NLB gets **one address per subnet** it is placed in,
but `rtc.node_ip` can advertise **one address**. Placed in three subnets it answered
on three addresses while naming one, and return traffic is only reverse-translated by
the ENI that owns the flow — so packets in worked and packets out were dropped.
`cross-zone-load-balancing` does not help; it only affects traffic reaching the pod.

Measured before the fix:

```
requestsReceived  5,  responsesSent      5     inbound fine
requestsSent     13,  responsesReceived  0     outbound dead
NewFlowCount_UDP 11   NewFlowCount 188          UDP tried, UDP failed
gateway:  code=101 flags=UC dur=11819ms         SFU closes the socket at its
                                                 ~12s connect timeout, client
                                                 retries, forever
```

Current configuration: **one subnet, one address**, advertised and answering.

### 4.5b Latency budget, and what was wrong with it

Time-to-first-frame decomposes into work that must happen and work that need not.
The original path did all of it in series, after the click:

```
  join POST         ~5 sequential round trips (2 to the SFU)      ~50 ms
  DNS + TLS + /validate to the SFU                              150-400 ms
  websocket + SDP exchange                                       ~100 ms
  ICE gathering                                                   see below
  DTLS                                                           ~100 ms
  getUserMedia (mic)                                            200-800 ms
  getUserMedia (camera)                                       1000-2000 ms
  publish + first keyframe                                       ~200 ms
                                                              ─────────────
                                                                 ~2-4 s, best case
```

Four things were wrong, and only the first explains minutes rather than seconds.

**1. No ICE servers at all.** Neither the SFU config nor the API gave clients a
STUN server, so a browser could not learn its own public address and offered only
host candidates — its LAN IPs. The SFU had to infer the client's address from an
inbound packet, which is why its logs showed `type(prflx/)` on every pair. That
works only while the direction the browser opened stays open, and leaves ICE nothing
to retry with. With no relay candidate either, a client whose network cannot carry
direct media has **nothing that works** — so it retries until something times out,
which is where "audio and video appear after two or three minutes" comes from.

*Fix:* `rtc.stun_servers` (the SFU passes these to every browser), and TURN, which is
the one candidate that always works. A relay makes connections *faster*, not slower:
ICE prefers a direct path when it can prove one and falls back in a single round trip
when it cannot, instead of timing out and starting over.

**2. `peerConnectionTimeout` left at its 15-second default.** On a path where media
cannot flow that is 15 s of nothing before the first retry — and the retry is what
switches the ICE preference to TCP. So the default turned an unusable UDP path into
half a minute of blank video before the fallback that *would* work was attempted.
Now stated explicitly at 8 s: long enough for a slow-but-working network to finish
DTLS, short enough to reach the TCP attempt while the audience is still watching.

**3. The camera was opened twice.** The pre-join screen acquires tracks for its
preview, stopped them, and the Room then re-acquired the same devices — a second
`getUserMedia`, worth 1–2 seconds on most machines, and a second permission prompt in
some browsers. The tracks are now handed to the Room and published directly, which
also removes the reason the two publishes had to be sequential.

**4. Nothing was warmed up.** `Room.prepareConnection()` resolves DNS, completes the
TLS handshake and validates the token; none of it needs to wait for the click. It now
runs while the presenter is still checking their camera on the pre-join screen, which
required hoisting the `Room` above that screen so it outlives it.

**5. Two SFU round trips per join, for one number.** `EnsureRoom` threw away the
room object `CreateRoom` returns, and the join path then called `ListParticipants` to
learn the occupancy that object already carried. That is a second round trip to the
SFU on every join — 500 of them when a full audience arrives at the top of the hour,
each one delaying somebody's connection. `EnsureRoom` now returns the count, and
`ListParticipants` is a fallback for the case where the SFU answers `AlreadyExists`
without a body.

**6. The attendee waited for a lookup before it could start joining.** Join keys were
stored as a flat list, which cannot answer "which key is for *this* webinar" — so the
room had to wait for `POST /registrations/lookup` to return before it could send the
join request. A `slug → joinKey` index now answers that from `localStorage`, so the
join goes out on mount. The lookup still runs, and is still the fallback for keys
stored before the index existed; it is simply no longer on the critical path.

The resulting order: DNS, TLS and token validation overlap the pre-join screen;
devices are opened once, during the preview; and after the click the only remaining
work is signalling, ICE, DTLS and a keyframe.

**What is code and what is not.** Items 2–6 are worth low seconds on a healthy
network and are in this repo. Item 1 is the one that produces minutes, and half of it
is deployment: STUN is a config line, TURN needs a hostname, a port and — for the
TLS-on-443 variant that gets through HTTPS-only firewalls — a certificate. Until TURN
is actually running, a client on an awkward network still has no candidate that
always works, and no client-side tuning changes that.

### 4.6 Where to look when something breaks

| Symptom | First place to look |
|---|---|
| Page loads, "Connecting…" forever | Gateway log for `/sfu/rtc/v1` — expect `101`. `UC` means the SFU closed it; `DC` means the browser did |
| Host cannot connect, attendees can | §4.5 step 4. It is the server→browser direction, every time |
| Connects, then black video | UDP is not reaching the SFU, or `node_ip` is not an address the browser can reach |
| 3 minutes then it works | Failed UDP phase before the TCP fallback lands. §4.5 step 3 |
| Microphone permission denied | `permissions-policy` on the response. §3.3 |
| Record does nothing | `RECORDINGS_ENABLED`, or the volume is not writable — the API write-probes at boot and refuses to start, so check its logs |
| Whole audience gets 429 | `JOIN_RATE_PER_MIN` below the real audience size. It is per IP, and an office shares one |
| API exits at startup | It validates its config and names the variable. Read the log |
| SFU will not start after a config change | LiveKit rejects unknown keys outright and names the field. Validate in a throwaway container first — §3.3 |
| Media fine for ten minutes, then everyone degrades | Not the app. `NetworkBandwidthOutAllowanceExceeded` in CloudWatch — the instance is out of network credit. `docs/CAPACITY.md` |
| Chat missing after a reload | `GET /webinars/{slug}/chat?since=0` directly. If the row is there it is a client merge problem, not a delivery one |
| Poll never appeared for the audience | The `polls-changed` nudge, then `pollsEnabled` in the controls, then whether the poll is `open` rather than `draft` |
| Promoted person has a dead microphone button | `promoted` metadata vs `allowUnmute`, which *Mute everyone* latches off. §2.3 |
| Virtual background never starts | `/mediapipe/wasm` must be reachable from the browser — `web/public/mediapipe/README.md` |
