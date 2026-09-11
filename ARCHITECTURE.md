# Webinar Liv — how it actually works

The current state of the system, diagram-led. Written after several rounds of changes, so
this is the document to trust when it disagrees with `DESIGN.md` — that one holds the
original design rationale and two sections still worth reading in full:

- `DESIGN.md` §4.5 — the media establishment ladder, and what to read when a connection
  fails. Nothing here supersedes it.
- `DESIGN.md` §4.5b — the latency budget and the six things that were wrong with it.

Capacity numbers and instance sizing live in [`docs/CAPACITY.md`](docs/CAPACITY.md).
Deployment mechanics are in [`DEPLOY.md`](DEPLOY.md).

---

## 1. The one idea everything follows from

**A webinar is not a meeting.** A meeting is N publishers and N subscribers. A webinar is
a handful of publishers and up to 500 subscribers who publish *nothing at all*.

Every significant decision in this codebase falls out of that asymmetry:

| because the audience never publishes… | …this becomes possible |
|---|---|
| their token carries `canPublish: false` | the stage cannot be hijacked, enforced at the SFU rather than by hiding buttons |
| their token carries `canPublishData: false` | the server is the only path for their chat, so it can decide who receives it and write it down |
| their token can carry `hidden: true` | attendees are invisible to each other because the SFU never tells them about one another — not because our JavaScript filters a list |
| one publisher's stream is sent once | 500 subscribers cost bandwidth, not encoding |

The corollary is the thing to keep in mind while reading: **permissions are minted into a
JWT by the API and enforced by the SFU.** The frontend never decides what someone may do;
it only renders what they were granted.

---

## 2. Components

```
                         browser
        ┌──────────────────────────────────────────┐
        │  Next.js app (React 19)                  │
        │   • room UI: bar, More grid, windows      │
        │   • livekit-client  ← the only WebRTC     │
        │   • MediaPipe segmentation (backgrounds)  │
        └────┬──────────────────┬──────────────────┘
             │ HTTPS            │ WSS + UDP/TCP (media + data channel)
             │                  │
   ┌─────────▼──────────┐       │
   │  Caddy :443/:80    │       │      one EC2 host, one public IP
   │  TLS, routing      │       │      3.82.201.244  (t3.medium)
   └────┬──────────┬────┘       │
        │          │            │
  ┌─────▼─────┐ ┌──▼────────┐  │
  │ web :3000 │ │ api :8080 │  │
  │ Next SSR  │ │ Go / chi  │  │
  └───────────┘ └──┬─────┬──┘  │
                   │     │     │
        ┌──────────▼─┐ ┌─▼─────▼──────────────────────┐
        │ Postgres   │ │ LiveKit SFU                  │
        │  :5432     │ │  :7880 signalling            │
        │            │ │  :7881 ICE/TCP fallback      │
        │ webinars   │ │  50000-60060/udp media       │
        │ users      │ │  :3478/udp TURN              │
        │ chat       │ │  host network mode           │
        │ polls      │ └──────────────────────────────┘
        │ recordings │      ▲
        └────────────┘      │ server API (room create,
                            │  token grants, SendData)
                            └── from the Go API only
```

Five long-running containers plus a one-shot `recordings-init` that fixes volume
ownership and exits, `docker compose` on one host. Four named volumes: `pgdata`,
`recordings`, `caddy_data`, `caddy_config`. `livekit` uses `network_mode: host` — with
a bridge it would advertise `172.17.0.1` as an ICE candidate, which no browser can reach,
and ICE would spend real time failing it before finding the one that works.

### Why one host with a public IP, and no load balancer

This was learned the hard way and is worth not rediscovering. **Media cannot go through an
AWS NLB.** UDP target groups force `preserve_client_ip` on and it cannot be disabled, so
the SFU replies directly to the browser and those replies leave via the NAT gateway with
the wrong source address — which browsers discard. Measured browser-side as
`tx=751140 rx=0`: a connection that looks established and carries nothing.

An internet gateway does symmetric 1:1 NAT, so a host with its own Elastic IP answers from
the address it was asked on. That is the entire reason this is not on Kubernetes.

---

## 3. Data model

```
users ──────────┬──< webinars ──┬──< registrations ──> (join key = the attendee credential)
                │               ├──< webinar_panelists
   host_id ─────┘               ├──< webinar_stage_grants   (promoted attendees, survives rejoin)
                                ├──< custom_questions
                                ├──< recordings
                                ├──< polls ──< poll_votes   (PK: poll_id + identity)
                                └──< chat_messages          (PK: client message id)
```

Eight migrations, `0001`–`0008`. Two of the keys are load-bearing and worth calling out,
because in both cases the database is enforcing a rule a handler cannot:

- **`poll_votes` primary key `(poll_id, identity)`** — one vote per person. Checking for an
  existing vote first leaves a window where two requests both find none.
- **`chat_messages` primary key = the *client's* message id** — makes delivery idempotent.
  A message resent because the response was lost collides and is ignored, so a reconnecting
  client merging a backlog cannot show a line twice.

And one partial index: `polls_one_open_per_webinar` — only one poll open at a time. Two
hosts, or one host double-clicking Launch, both reach the database and exactly one wins.

The session controls live in columns on `webinars`, not in process memory: a control has to
survive an API restart and apply to somebody who joins ten minutes after it was set.

---

## 4. The three channels

Understanding which channel carries what explains most of the system.

```
 ┌───────────┐   1. HTTPS ────────────────────────►┌──────┐
 │           │      auth, schedule, join, controls, │ API  │
 │  browser  │      chat history, polls, uploads    └──┬───┘
 │           │                                         │ server API
 │           │   2. WSS signalling ──────────────►┌────▼────┐
 │           │      SDP, ICE, permissions,        │ LiveKit │
 │           │      room metadata broadcast       │   SFU   │
 │           │                                    └────┬────┘
 │           │   3. UDP media + data channel ─────────►│
 └───────────┘      RTP audio/video, realtime msgs     │
```

**1. HTTPS to the Go API.** Everything durable. The API is also the only thing that talks
to LiveKit's *server* API — it mints tokens, creates rooms, moderates participants and
sends data packets. No browser holds the LiveKit API key.

**2. LiveKit signalling.** One WebSocket per participant, terminated by the SFU. Also how
one host action reaches 500 browsers: the API writes `RoomMeta` into LiveKit room metadata
and the SFU pushes it down every connection already open. Nobody polls.

**3. The data channel.** RTP for media, plus these realtime messages:

| kind | who may send | notes |
|---|---|---|
| `chat` | **the server only** | see §6 |
| `question`, `upvote` | anyone | Q&A |
| `hand` | anyone | raise / lower your own |
| `lower-hand`, `hands-cleared` | the stage | `decode` rejects them from an attendee |
| `reaction` | anyone | one tap → 20 emoji rendered locally |
| `unmute-request` | the stage | a server cannot start somebody's microphone |
| `polls-changed` | **the server only** | a bare nudge; each client re-reads its own view |

`decode()` in `web/lib/realtime.ts` is the single trust boundary. Every field is validated
and every string clamped before anything reaches React.

---

## 5. Permissions: one table to remember

Minted by `lk.GrantFor` into the JWT. **LiveKit reads a nil pointer as "grant everything"**,
so every field is set explicitly — `lk_test.go` asserts this for every role, and it is the
most important test in the repo.

| | host | panelist | attendee | promoted attendee |
|---|---|---|---|---|
| `canPublish` | ✅ | ✅ | ❌ | ✅ (or mic only) |
| `canSubscribe` | ✅ | ✅ | ✅ | ✅ |
| `canPublishData` | ✅ | ✅ | **❌** | ✅ |
| `roomAdmin` | ✅ | ❌ | ❌ | ❌ |
| `hidden` | ❌ | ❌ | when the host hides the audience | ❌ (promotion un-hides) |

Three subtleties that caused real bugs:

- **"Allow to speak" vs "Bring on stage."** A microphone-only grant is `canPublishSources:
  [MICROPHONE]`. An *empty* source list means every source, so "nothing" has to be
  `canPublish: false` — an empty list would hand a silenced attendee a camera.
- **`mutedByHost` is metadata, not a permission.** An attendee and a silenced speaker both
  lack a microphone; only metadata can say which. Without it the UI cannot offer "allow to
  speak again".
- **`promoted` is metadata too.** A promoted attendee and a scheduled panelist hold
  identical permissions, and the difference decides whether the room-wide "panelists may
  not unmute themselves" switch applies. Without it, bringing someone on stage after a
  *Mute everyone* gave them a working camera and a dead microphone button.

---

## 5a. Two gates that were not gates

Both found by reading the scheduling and join paths end to end, both confirmed against the
live deployment before and after.

### The passcode was decoration, and it leaked

`webinars.passcode` was stored, length-validated, returned to the client — and **never
compared to anything**. Two independent faults, either of which alone made it worthless:

| | |
|---|---|
| **leaked** | `GET /api/webinars` and `GET /api/webinars/{slug}` are unauthenticated and serialised the whole `types.Webinar`, passcode included. Measured on the live instance: `curl` with no cookie returned `"passcode":"SECRET-9931"`, and the browse list returned every webinar's. |
| **unenforced** | No code path read it. A stranger could register and be issued a join token without supplying it. |

The fix is in two halves because the field is not secret from everyone — it is the host's to
hand out:

- `publicWebinar()` in `internal/api/webinars.go` strips it, and sets `passcodeRequired` in
  its place so the registration form still knows whether to ask. Applied to the two public
  endpoints and to `/me/registrations`, which embeds a webinar for an attendee. The
  ownership-scoped subtree is deliberately untouched — a `json:"-"` tag would have been
  simpler and would have hidden it from the host as well.
- `validateRegistration()` enforces it. **Registration is the only gate**, and that is
  correct rather than lazy: a join key is minted nowhere else, and `/join` accepts that key
  as the credential. Checking at both would ask somebody who already proved it to prove it
  twice.

Case-insensitive after trimming, matching the join-key alphabet's reasoning — this is a code
read out on a call. The entropy given up is not what protects a webinar; the rate limiter on
`/register` is. Constant-time compare because it costs nothing.

**Enforcing it is a behaviour change**, and the test suite named five places that depended on
the old behaviour: they registered for the seeded `scaling-webrtc-10k`, which carries a
passcode, and had been sailing through. No webinar on the live instance had one set, so
production was unaffected.

### An attendee could join a webinar weeks early

`handleAttendeeJoin` rejected only `ended` and `draft`. So an approved registration could be
exchanged for a token at any time — a month before the scheduled start — which created the
SFU room and dropped the attendee into the room's *"Waiting for the host to start"* state.
That message is a lie in that situation: the host was not late, the webinar was not that day.
The UI made it worse by showing **Join the webinar** the instant a registration succeeded,
whatever the date.

`joinGrace` is 15 minutes. The rule has two halves and tightening the first is how you break
the second:

```
too early     refused, with the time it opens
started early accepted — status live stops the schedule mattering at all
started late  accepted, because people are already sitting there waiting
host/panelist never gated; they have to get in beforehand to set up
```

The web side gates the button on the same rule and shows the opening time instead.
`JOIN_GRACE_MIN` in `register-form.tsx` must track `joinGrace` — two copies of one number,
and the alternative is worse: a button the server refuses, or a hidden one it would have
allowed. The server is the authority; the constant only decides what to offer.

### A test that could not fail

Worth recording because it nearly cost the whole exercise. The first version of the
late-start test scheduled a webinar in the **past** and started it, to prove a live webinar
ignores its schedule. Removing the guard it was meant to protect did not fail it — a past
schedule is never "too early" whatever the rule is. The case that pins the guard is a
**future** webinar the host opened ahead of time. Both are now tested and only one of them
detects the mutation.

The API integration suite also skips silently without `TEST_DATABASE_URL`, so a first run
reported `ok` with every passcode test skipped, and three mutations "passed". `make test-api`
sets it; running `go test ./...` by hand does not. Check for `SKIP` before believing a green
run.

---

## 5b. Three experiences, separated by route

One deployment serves a host product, a participant page and a panelist invitation. They are
kept apart by URL and enforced before anything renders — not by hiding controls, because a
hidden control still has a URL somebody can type.

```
HOST         /host/login → /host → /host/<slug> → /host/<slug>/room
PARTICIPANT  /webinars/<slug> → register → confirmation → /webinars/<slug>/room
PANELIST     /host/<slug>/room                     (an invitation, not a dashboard)
```

### Three layers, and only one is authoritative

| layer | where | what it does |
|---|---|---|
| the rule | `lib/access.ts` | pure, tested, no I/O |
| enforcement | `middleware.ts` | runs before the page renders, answers with a 307 |
| **authority** | the Go API | `requireHost`, `requireOwnership`, owner-or-panelist on the stage |

Middleware matters because a page that renders and *then* decides has already sent its markup —
the dashboard shell, the sidebar, the webinar's name. "A participant must never see the host
dashboard" is not satisfied by a component returning null inside a layout that already drew. It
is deliberately **not** the security boundary: the API is, and it was already correct. This
layer turns a guessed URL into a useful redirect instead of a dashboard frame around an error.

The matcher covers `/host/*`, `/my-webinars` and `/account` only. The participant journey is
absent on purpose — a registration link is open to everyone, so running middleware there would
buy nothing and cost a matcher evaluation on the busiest path in the product.

### Measured on the deployed instance

| path | anonymous | participant | host |
|---|---|---|---|
| `/webinars/<slug>` | 200 | 200 | 200 |
| `/webinars/<slug>/room` | 200 | 200 | 200 |
| `/host` | → `/host/login?next=/host` | → `/account` | 200 |
| `/host/new` | → `/host/login?next=…` | → `/account` | 200 |
| `/host/<slug>` | → `/host/login?next=…` | **→ `/webinars/<slug>`** | 200 |
| `/host/<slug>/edit` | → `/host/login?next=…` | **→ `/webinars/<slug>`** | 200 |
| `/host/<slug>/room` | → `/host/login?next=…` | 200, then → `/webinars/<slug>` | 200 |
| `/my-webinars`, `/account` | → `/login?next=…` | 200 | 200 |

### The panelist link is why `canHost` is not the rule

A guest speaker is invited by name to somebody else's webinar. They have an ordinary account and
no hosting capability, so gating `/host/<slug>/room` on `canHost` would break the invitation.
Whether *this* account is on *that* webinar's stage is not something a session cookie knows — so
middleware lets any signed-in account ask, and the API answers. `HostRoomGate` turns that 403
into `router.replace('/webinars/<slug>')`: a participant who was forwarded a panelist link lands
on the registration page rather than a denial with a dashboard link on it.

Verified in a browser: a signed-in non-panelist opening `/host/<slug>/room` ends up on
`/webinars/<slug>` with zero `/host` links in the DOM.

### What the participant page does not contain

No `TopNav`. `ParticipantHeader` renders the operator's name and **nothing that is a link** — a
clickable logo leading to a webinar catalogue is the same leak in a friendlier shape. Also
removed: the "← All webinars" back-link, the "All my webinars" link on the confirmation, and the
**Webinar ID**, which is the host's own reference for a session and appears in the dashboard and
in the invitation the host composes.

Measured on the rendered page: `linksToHost: []`, `linksToAppNav: []`, `hasNavElement: false`.

Two words survive a scan for forbidden terms and both are correct:

- **"Host"** in copy such as *"The host reviews each registration before approving"* — a
  reference to the person, never a link. The speaker list is labelled **Presenters** rather than
  "Host and panelists" precisely so the dashboard's word is not reused on a participant page.
- **"account"** in *"Registering without an account is fine … Create an account"*, which links to
  `/signup?next=/webinars/<slug>` and returns them to the same webinar. That is participant
  functionality — it keeps a registration across devices — not host navigation.

### One hole the tests found in the rule itself

`decideAccess` originally allowed the stage room on `segments.length >= 3`, so
`/host/<slug>/room/anything` was allowed too. Harmless today because no such page exists, and
exactly how a future `/host/<slug>/room/settings` becomes readable by a participant. It is now
`=== 3`, and the test that caught it asserts on an unrecognised subpath rather than on the paths
that happen to exist.

`TopNav` also builds its links from the viewer now — *My webinars* only when signed in, *Host*
only when `canHost`. That is presentation, not protection: the routes refuse regardless, and a
link that bounces is worse than no link.

---

## 6. Chat: the most-changed part of the system

Chat went from "in flight only" to persistent, and the reason it looks the way it does is
that **the audience holds no data-publish grant**.

```
  ATTENDEE                                  HOST / PANELIST
     │                                            │
     │ POST /webinars/{slug}/say                  │ POST /webinars/{slug}/say
     │  { id, text, destination }                 │  (same path — see below)
     ▼                                            ▼
  ┌────────────────────────── API ──────────────────────────┐
  │ 1. resolve sender from the CREDENTIAL, not the body     │
  │ 2. attendee? destination := host's setting (ignore theirs)│
  │ 3. INSERT chat_messages  ← written down BEFORE sending   │
  │ 4. panelists-only? compute recipients from the SFU roster│
  └───────────────────────┬─────────────────────────────────┘
                          │ SendData(destinationIdentities)
                          ▼
                    ┌──────────┐
                    │   SFU    │  delivers to exactly those identities
                    └────┬─────┘
              ┌──────────┼──────────┐
              ▼          ▼          ▼
            host     panelist    sender     ← the audience is NOT in the list
```

Four consequences, each deliberate:

1. **The host cannot be overridden.** An attendee's `destination` field is read and
   discarded; the room's setting decides. A panelists-only message is never *sent* to an
   attendee's browser, so nothing is trusted to hide it.
2. **The sender is stamped from the credential.** `from` used to be whatever the browser
   wrote — an attendee could label themselves *Host*.
3. **The host relays too.** An HTTP round trip on the same host costs a few milliseconds;
   a transcript missing everything the presenter said is not a transcript.
4. **Recorded before delivered.** A message recorded but not delivered arrives on
   everyone's next sync. A message delivered but not recorded is gone on the next reload.
   Only one of those is recoverable.

### Reconnection

```
  join, or reconnect
        │
        ▼
  GET /webinars/{slug}/chat?since={highest seq held}
        │
        ▼  merge by message id
  ┌─────────────────────────────────────────┐
  │ overlap with the live stream is EXPECTED │
  │ — a cursor cannot be advanced and a      │
  │ socket drained in the same instant       │
  └─────────────────────────────────────────┘
```

`since=0` returns the conversation so far, which is what makes arriving twenty minutes late
useful. The same endpoint answers both questions with a different cursor, so one code path
cannot disagree with itself. The backlog is filtered by the *same* audience rule live
delivery used — replaying history must not hand a late joiner what the SFU refused them.

### Images

One request, not two: `POST /chat/image` stores the bytes *and* creates the message. An
upload endpoint returning a handle for a second call leaves orphaned bytes every time the
second call doesn't happen. The client compresses to ≤1600px WebP first — the server's 5 MB
cap is a backstop against a client that skipped that step, not the working limit. The type
is sniffed from the bytes, and `mediaUrl` points at our API, never at storage.

---

## 7. Polls and quizzes

A quiz is a poll with a right answer — same voting, same tally, one flag. Two views of the
same rows, and the **server** decides which you get:

| | the stage | the audience |
|---|---|---|
| draft polls | ✅ | ❌ |
| vote counts, percentages, totals | ✅ | **never** |
| a quiz's correct answer | ✅ | only once voting closes |
| your own answer | ✅ | ✅ |

The audience gets no numbers at all. A visible tally makes the answers stop being
independent — whoever hasn't voted can see which way the room is going. It's withheld by
not being *sent*, so there's nothing for a client to hide.

```
 host clicks Launch
        │
        ├─► DB: state = open (partial unique index: only one)
        │
        └─► SendData { kind: "polls-changed" }      ← a bare nudge, no payload
                    │
                    ▼
            every client re-reads ITS OWN endpoint
                    │
                    ├─ host    → GET /host/webinars/{slug}/polls   (tallies, answers)
                    └─ audience→ GET /webinars/{slug}/polls        (question + options)
                                        │
                                        ▼
                              PollPopup appears automatically
```

The nudge carries no payload precisely *because* the two views differ — putting a poll in
the packet would broadcast one of them to a room containing both.

---

## 8. Adaptive bitrate and network handling

```
  publisher                          SFU                        subscribers
  ┌────────────────┐                                     ┌──────────────────┐
  │ 720p  1.7 Mbps │──┐                                  │ laptop  → 720p   │
  │ 360p  0.5 Mbps │──┼──► one upload, three layers ──────► phone   → 360p   │
  │ 180p  0.15Mbps │──┘    SFU picks per subscriber      │ train   → 180p   │
  └────────────────┘                                     └──────────────────┘
        ▲
        │ getStats every 2s: loss, RTT, jitter, headroom
        │
   ┌────┴─────────────────────────────────────────┐
   │ ≥2% loss or ≥300ms RTT, 2 samples → step DOWN │
   │ ≤0.5% and ≤180ms,      6 samples → step UP    │
   └───────────────────────────────────────────────┘
```

Asymmetric on purpose: stepping down late *is* the lag, and stepping up eagerly recreates
the congestion that caused the step down — the audience watches the resolution pump.
Applied via `sender.setParameters()`, not by republishing, so there is no keyframe hitch
during the moment the connection is already struggling.

**Audio is never stepped down.** It has RED (each packet carries a copy of the previous
one), DTX (silence isn't transmitted), Opus tuned for speech, and `networkPriority: high`
so it wins the browser's own send queue against video.

VP8 simulcast rather than VP9/AV1 SVC: SVC is better per bit, but decode cost lands on the
*subscriber*, and in an audience of 500 there are always phones that software-decode VP9 at
a crawl.

---

## 8a. Publish quality is not a setting

There used to be a **Send video at** picker on the pre-join screen and again in the settings
window, offering 360p through 1080p. Both are gone, and the reasoning is worth keeping because
the control looked helpful:

- It asked the wrong person. A presenter knows what their camera is. They do not know their
  uplink four seconds from now, and that is the number that decides whether 1080p arrives as
  1080p or as a stutter.
- Applying it **restarted the camera**, because capture constraints are baked into a track
  when it is created. So the one control offered for a struggling connection produced a
  visible cut for the audience.
- It could not change its mind. The ladder in `network.ts` samples every two seconds and
  moves within four; a dropdown is a decision made once, before the call started.

What replaced it is one capture resolution (`CAPTURE`, 720p — the highest tier most laptop
cameras genuinely deliver) and a three-rung published ladder the app drives itself.

### The third signal

Stepping the ladder used to key on **loss** and **RTT** only, and that left a real gap: when
an uplink is narrow but clean, congestion control starves the encoders rather than dropping
packets. The picture goes soft, the frame rate sags, and every threshold stays green. A narrow
uplink is the common case on domestic wifi and a phone hotspot — which is exactly the case
that most needed handling.

So `judge()` now also compares the browser's own `availableOutgoingBitrate` against what the
current rung actually costs. That budget is **derived** from the rungs rather than tabulated,
because a hardcoded table goes stale the first time a preset changes and does it silently.

| | |
|---|---|
| step down | the estimate falls below **80%** of what the current rung needs |
| step up | it clears **140%** of what the rung above needs |
| no estimate | ignored, not read as zero — a missing number must not step a healthy presenter to the floor |

### A distant server is not a bad connection — the ratchet bug

The RTT half of `judge()` was **absolute**: step down at `rtt >= 300`, step up at `rtt <= 180`.
Both numbers are defensible in isolation and together they were a serious bug on this
deployment.

The SFU is in **us-east-1** and the audience is in **India**. Measured round trip: **264-285 ms**
(`e2e/probe-latency.mjs`, three separate runs). So:

- 280 ms sits ~20 ms below the step-down trigger. Any ordinary jitter spike crosses it, and two
  samples — four seconds — step the publisher down.
- recovery required **180 ms**, which on that route is *physically impossible*.

The ladder was therefore a **one-way ratchet**: `full → reduced → minimal` within the first
minute of a second person joining, and never back up. The presenter spent the rest of the
session sending a single 180p layer at ~150 kbps. The only clue in the UI was a *Reduced
quality* badge. This is what "there was no lag initially and now there is" was.

The fix is to measure the part of the delay that is actually a symptom:

```
excess = rtt − floor          floor = best rtt in the last 60s (30 samples)

step down   excess ≥ 120 ms          step up   excess ≤ 50 ms
```

Propagation delay is a constant of distance and no bitrate change affects it. **Queueing**
delay is congestion, and sending less genuinely drains it. Delay-based congestion control has
worked on the excess-over-minimum for decades; the absolute version was measuring the wrong
thing.

Three details that each fix a distinct failure:

- **The floor is a window, not an all-time minimum.** An all-time minimum can never rise, so
  somebody moving from wifi to a hotspot would be judged forever against a floor their new
  route cannot reach — the same permanent degradation in a different costume.
- **A reconnect clears the window.** ICE can land on a different candidate pair (a TURN relay,
  or TCP) whose honest floor is far higher; judging it against the old route's minimum would
  read the difference as 200 ms of queueing and step down immediately.
- **An unknown floor gives latency no vote.** The first sample after connecting is routinely
  the worst of the session — the connection is still ramping — and it is taken at exactly the
  moment the user reported the lag appearing.

There is deliberately **no absolute ceiling left**. A 400 ms route is a bad seat, not a bad
connection, and degrading video on it costs picture while saving no latency at all. What an
absolute threshold was standing in for is covered better by the other two signals: a saturated
uplink shows up in `availableOutgoingBitrate`, a broken one loses packets.

Verified to fail: restoring the absolute thresholds fails five of the new assertions, including
both "a presenter already reduced on that route can climb back" and "an unmeasured floor gives
latency no vote".

The readout now shows **Best round trip** beside **Round trip**, and the connection tooltip
quotes the *queueing* rather than the raw figure. Distance was being read as a fault, which
sends people to restart a router that is working.

### Two tiles that were the wrong size

Both are consequences of the same thing — position is what `wanted` turns into a simulcast
layer — and neither is about the network:

- **Your own camera was taking the main stage.** The host is role 0 and usually also the local
  participant, so a host with one panelist watched a large picture of *themselves* while the
  person talking sat in a thumbnail at **LOW (320×180)**. `sortTiles` now prefers a remote tile
  over your own, as a tie-break *within* a role — below the role comparison, not above it,
  which the test for it caught: above, being local pushed a host below a promoted attendee.
- **The active speaker was stuck at LOW.** Removing speaking from the sort (§8b1) also removed
  the thing that used to give a talking panelist a better layer. The layer is now floored at
  **MEDIUM** for the highlighted speaker — the tile does not move, but the SFU is asked for
  more pixels for the one face anybody is looking at. Driven by the debounced highlight, so
  this changes at most once every 450 ms. Asking an SFU for a better layer for the current
  speaker is precisely what an SFU is for.

### The number that has to be tested rather than eyeballed

Removing the picker made this the *only* thing deciding what a presenter sends. There is no
longer a human to reach for 360p when the app leaves them on 720p over a hotspot, so `judge`
is a pure exported function with tests in `lib/network.test.mts`.

One of those tests was worthless when first written and is worth recording. It asserted that
no bandwidth is simultaneously `bad` and `good` — and that is untestable by construction,
because the tiers differ by roughly 3× so their budgets never overlap however badly the margins
are chosen. It passed with the up-margin set to 0.5, which is precisely the value that pumps.

The property that actually matters is about the **step**, not a sample: if a bandwidth is
enough to climb *off* a tier, it must also be enough to *stay* on the tier above. Otherwise
the ladder steps up, immediately finds itself too narrow, steps back down, and the audience
watches the resolution oscillate. That version fails on the mutation; the first did not.

### Three smaller things in the same pass

**The pre-join screen asks nothing about quality.** The resolution picker was replaced by
*Join with video* / *Join with audio* toggles, and those were then removed as well — the
preview already carries exactly those two controls as buttons on the image, and two places to
set one thing is worse than either alone. The buttons over the preview are the ones people
reach for, because that is where the effect is visible. What is left in that column is the
camera and microphone device pickers and the Join button.

**The stage shows the camera while connecting.** It used to be a pulsing dot on black, on the
reasoning that anything more would read as an instruction. That was right about instructions
and wrong about the dot: a presenter who has just enabled their camera and pressed Join is
asking one question, and a black rectangle answers it badly. The track already exists — it was
captured on the pre-join screen — so it is carried through context and rendered until the
published track replaces it. The dot remains for someone joining to share a screen, who has
nothing to preview.

**Record does not appear until connected.** It used to mount with the control bar, so a host
looking at "Connecting…" was offered a button that would have composited a black stage.

---

## 8a1. "You were disconnected", and why it was our bug

A host reported seeing the terminal disconnect screen **while joining**. The SFU logs answer
it. Forty-eight hours on the deployed instance, 140 sessions:

```
91  CLIENT_REQUEST_LEAVE             somebody pressed Leave
42  PEER_CONNECTION_DISCONNECTED     ← the screen they saw
 4  DUPLICATE_IDENTITY
 2  SERVICE_REQUEST_REMOVE_PARTICIPANT
 1  SIGNAL_SOURCE_CLOSE
```

alongside `105 short ice connection`, `170 ice reconnected or switched pair` and
`74 resuming RTC session`. Some of that 42 is this repo's own headless probes, which are
SIGKILLed and therefore never send a graceful leave — so it is not a 30% production failure
rate. But the shape is real: the ICE connection to the SFU drops, often, on a path with
**~275 ms of round trip** (§8d).

**The infrastructure is not the fault.** Checked rather than assumed: the security group
allows the whole media range (`udp 50000-60060`, `tcp 7881`, `udp 3478`), `peerConnectionTimeout`
is 15 s against a healthy connect of about two, and the SDK's own recovery works — those 170
reconnects and 74 resumes are drops that nobody ever saw.

**The bug was what happened when the SDK gave up.** `classifyDisconnect` mapped anything
unrecognised to `lost` and the component answered `lost` with a terminal screen and a manual
*Rejoin* button, on the first failure. A dropped uplink is the internet; a dead end is a
product decision. So:

| | |
|---|---|
| `lost` | retried, 1 s → 2 s → 4 s → 8 s, room stays mounted, banner reads *Reconnecting… (2 of 4)* |
| everything else | terminal immediately, and that is correct — see below |
| a connect that never landed | retried on the same ladder. It used to be final, and the usual cause is a network that was not ready yet |
| after the ladder | the terminal screen, because a network that is really gone deserves the truth |

`removed`, `ended` and `duplicate` must **never** be retried, and each fails differently if
they are. Retrying `removed` walks a person the host ejected straight back in. Retrying
`duplicate` is the worst: two tabs holding one identity evict each other in a loop that looks
to both like the app crashing.

Attempts are forgiven only after the connection has held for **30 seconds** (`STABLE_MS`).
Without that, a connection flapping every twenty seconds retries for ever, because each
success resets the counter — resilience becomes a session nobody can escape.

### Why this is unit-tested and not browser-tested

`lib/recovery.test.mts` exists because a real media-path failure **cannot be injected from a
harness**. Both routes were tried:

- Chrome DevTools `Network.emulateNetworkConditions` with `offline: true` does not apply to
  WebRTC transport. Measured: a 100-second offline window left the peer connection running
  and the SDK never noticed.
- livekit-client's `simulateScenario` needs a handle on the `Room`, which the production build
  deliberately does not expose (the `__lkRoom` hook is gated on `NODE_ENV`).

So the browser proves one thing — a six-second outage now survives without the terminal
screen, which it previously did not — and the ladder's shape is settled by unit test:
non-retryable reasons, monotonic backoff, termination, and 1-based contiguous attempt numbers
because they are shown to a person. Verified against four mutations.

### Two smaller things in the same pass

**The stage toast says "Connected".** It used to read *"You're on the stage. Your microphone
and camera controls are below."* — a sentence describing buttons the presenter can already
see. A host or panelist arrived with publish rights and pressed Join, so "Connected" is the
whole news. A **promoted attendee** still gets the longer sentence: they did not ask for it and
their bar has just grown two controls, which is worth saying.

**Leave is disabled while the first connection is being established** and re-enabled once it
is. Not during a *reconnect*, though — somebody whose network has gone is exactly who needs a
way out, and trapping them behind a spinner is worse than an untidy disconnect.

---

## 8b. The room UI: bar, grid, windows

Every tool — Chat, Q&A, Polls, Participants, Settings, Host tools — opens as an
independent floating window. There is no side panel.

```
  ┌──────────────────────────────────────────────────────────────┐
  │ header: topic · REC · network · role                         │
  ├──────────────────────────────────────────────────────────────┤
  │                                        ┌───────────────────┐ │
  │                  STAGE                 │ ▣ Chat      ─ ▣ ✕ │ │
  │                                        ├───────────────────┤ │
  │        ┌─────────────────────┐         │                   │ │
  │        │ ▣ Participants ─▣ ✕ │         │  …                │ │
  │        ├─────────────────────┤         │                   │ │
  │        │ …                   │         └──────────────────◢┘ │
  │        └────────────────────◢│           drag the title bar, │
  │                               resize any edge, ✕ to close    │
  ├──────────────────────────────────────────────────────────────┤
  │ 🎤 📹 🖥 ⏺   │  👥 💬 ❓ 📊 …pinned slots…  │  ⊞ More │ Leave │
  └──────────────────────────────────────────────────────────────┘
                        drag between the bar and the More grid
```

Why not a docked column, which is what this replaced: a 336px panel took a third of
the stage on a 1280px laptop, and only one of the four tools could be open at a
time. A host trying to read a question while watching the participant list simply
could not.

**State** — `lib/tools.ts`, four pieces, each earning its place:

| | what it is | why it exists |
|---|---|---|
| `pinned` | what the user dragged onto the bar | persisted, or "customise" means "until you reload" |
| `overflow` | the order tools appear in the grid | a grid that reshuffles itself has to be re-read every time |
| `recent` | FIFO of what has been used | fills bar slots the user has not claimed, so an uncustomised bar is not an empty one |
| `windows` | open windows: rect, stacking order, minimised | a map, because every operation is "the window for this tool" |

`pinned`/`overflow`/`recent` persist to `localStorage`; **windows deliberately do
not**. Restoring them across a reload would drop somebody into a session behind four
windows they opened an hour ago, and geometry saved against a different viewport is
wrong more often than right.

**The bar has three zones**, and the split is the design. Microphone, camera, share
and record are fixed and never customisable — they are what you reach for
mid-sentence, and a control you must open a drawer to find is one you mute yourself
too late with. The middle is slots, capacity by breakpoint (2 → 6), pinned first then
filled from `recent`. More and Leave are fixed on the right, Leave last because its
position must never move under the cursor.

**Drag and drop** is pointer events, not HTML5 DnD: `dragstart` never fires on touch,
the browser's drag image cannot be styled, and `dragover` fires on its own cadence so
the drop indicator lagged the cursor. Mouse promotes to a drag after 6px; touch needs
a 350ms long press, because a finger moving 6px is how a person taps. Dropping
anywhere that is not the bar unpins — treating "dropped on nothing" as a cancel would
make unpinning require hitting a target that is only open if you happened to open it.

Three things in this subsystem are less obvious than they look:

- **Collapsing is a prop, not a second component.** A minimised window — and on a
  phone, any window that is not on top — renders as its title bar. Rendering that
  somewhere else in the tree would make it a different React element and throw away
  a half-typed message and an hour of scrolled chat. So there is one tree position
  per tool and four shapes.
- **Stacking uses a rank, not the z counter.** `nextZ` is monotonic and never reset,
  so after enough focus changes it climbs past the toast stack at `z-100` and a chat
  window covers the notification telling somebody they have been muted. There are at
  most eight tools, so the sorted index is bounded by construction.
- **`keepMounted` is per tool.** True for Chat, Q&A and Participants, where there is
  a draft or a scroll position to lose. False for Polls, which polls the tally of an
  open poll every four seconds — a minimised window doing that for an hour is a
  request nobody is looking at.

Not implemented: **breakout rooms**, which the brief listed in the grid. The product
has no breakout rooms, and a grid cell that opens nothing is worse than an absent one.

---

## 8b1. The stage does not move when somebody speaks

Two rules, and they only make sense together:

| | decided by | changes when |
|---|---|---|
| **where a tile is** | `sortTiles` (`lib/layout.ts`) | pinning, a share starting, a camera going on or off, someone joining or leaving |
| **who is highlighted** | `nextHighlight` (`lib/speaker.ts`) | the loudest speaker holds the floor for 450 ms |

Voice activity appears in the second row only. It used to appear in both, and the stage was
in constant motion.

### What was wrong

`sortTiles` ranked speakers third, above role. So every change of loudest speaker — several
times a minute in a conversation, several times a second in a noisy room — pulled that tile to
the front and pushed everybody after it down one. Three consequences, and only the first is
cosmetic:

- **the strip beside a screen share reshuffled** under the viewer's cursor, so clicking a face
  was a guess. This is what the report described as tiles flipping when a share starts;
- **position drives quality.** `wanted` in `stage.tsx` assigns `HIGH` to the first tile and
  `LOW` to the strip, so a tile promoted for saying "yes" was re-requested at a higher layer
  and demoted a second later — a visible resolution change on somebody who had not done
  anything;
- **reordering moves DOM nodes**, which is the one kind of re-render that can make a `<video>`
  flash black.

And the highlight itself was per-tile: every `ParticipantTile` called
`useIsSpeaking(participant)`, so nine faces meant nine components re-rendering on every
audio-level update, and several could be ringed at once. The border stopped meaning "this is
who is talking" and started meaning "this microphone is above the threshold".

### The debounce

One subscription, in `ActiveSpeakerProvider`, publishing one identity through context.

```
SWITCH_MS = 450    a new speaker must hold the floor this long before the border moves
CLEAR_MS  = 1500   silence must last this long before the border goes out
```

Asymmetric on purpose. 450 ms is about the length of a short word, so a cough, an "mm" and a
chair moving never take the border off the presenter, while a real handover feels immediate.
1.5 s is longer than the pauses *inside* continuous speech — between sentences, while changing
a slide — because a symmetric threshold makes the border blink through a single paragraph.

Any change in the reading restarts the clock, including a change back to whoever already holds
the border. So an interjection leaves the border where it was with nothing pending, which is
why one threshold is enough and there is no queue of candidates.

The machine lives in a **ref**, not in state, and only `current` is published. A reading that
does not move the border therefore re-renders nothing at all: `setCurrent` is called with the
value it already holds and React discards the update. That is the "no unnecessary re-renders on
voice activity" requirement, discharged rather than hoped for.

The border is an `outline` at constant width whose *colour* changes between transparent and
`--color-ok`. Two reasons: a `border` would change the box and nudge every neighbour by two
pixels — the exact movement being removed, reintroduced by the thing meant to replace it — and
`outline-width` going 0 → 2 cannot be transitioned, so the border would snap on and off instead
of fading between tiles.

A screen share is never highlighted. Its owner is usually the one talking, and ringing a slide
deck every time they speak is the flicker this exists to remove.

### What "Speaker view" means now

The main stage follows the pin, then the screen share, then the first tile in the stable
order — the host. It does **not** follow the active speaker, because enlarging whoever talks
moves every other tile with it, which is what the report asked to stop. Pinning is how a viewer
puts somebody else on the main stage, and it outranks everything including a live share.

### The one real flip, and where it was

Not the share. Your own camera is mirrored in the joining preview — a self-view has to be a
mirror or people reach the wrong way when adjusting the frame — and the tile was **not**
mirrored, so your own image flipped left-right exactly once, at the moment you landed on the
stage. Now both are mirrored, and nobody else's camera ever is: a remote camera arrives the way
its owner publishes it, and mirroring it would reverse the text on their slide and their shirt.

CSS only. The recorder composites from the track, so a recording still shows what the audience
saw.

### Tested as a property, not as an expectation

`layout.test.mts` flips the speaking flag onto each tile in turn, and then onto all of them,
and asserts the order is byte-identical every time. A single hardcoded expected list would
still pass if speaking were re-introduced below role but above camera state; the property
cannot. Verified by putting the clause back: seven assertions fail.

`speaker.test.mts` replays scripted readings on a controlled clock — 32 checks covering the
cough at the moment of a handover, the A-B-A-B stutter, the gap between two sentences, and the
requirement that a steady speaker produces no new state object. None of it is reachable by
watching a live call.

---

## 8c. Virtual backgrounds: why the segmenter is ours

**Two modes: off, or blur.** Solid colours and the ten bundled images were removed at the
operator's request, along with their assets and the picker grid.

The request was made to reduce lag, and it does not — which is worth stating plainly here so it
is not "fixed" again in the same direction. The cost of a virtual background is almost entirely
the **segmentation**: MediaPipe deciding per frame which pixels are the person. That runs
identically whichever mode is selected. What happens afterwards is comparatively free, and blur
is the **more** expensive of the two that were kept: a separable Gaussian across two
half-resolution render targets, versus a single texture lookup for an image. So this change
removed the cheaper option and kept the dearer one.

The lever that does reduce cost is `{ mode: "none" }`, which skips segmentation entirely. The
per-frame cost is measured and shown in the settings window (`useBackgroundCost`), so nobody has
to take that on trust — and `SLOW_FRAME_MS` already turns the background off automatically on a
device that cannot keep up.

The blur is composited by `lib/segmenter.ts` rather than by
`@livekit/track-processors`' `BackgroundTransformer`. Two of that implementation's
choices are not reachable through its API and both are visible on screen:

- **`outputCategoryMask: true, outputConfidenceMasks: false`.** A category mask is a
  hard per-pixel classification — 0 or 1, nothing between. Upscaled from the model's
  256×256 to a 1280×720 frame, every mask pixel becomes a 5×3 block, so the edge of a
  person is a staircase. Their shader tries to recover a soft edge with a `dFdx/dFdy`
  gradient trick and cannot: the detail is not in the data.
- **The square 256×256 model on a 16:9 frame.** The frame is squashed to fit, so
  horizontal detail — where a shoulder or an arm edge lives — is halved before
  inference starts.

Both are set after the point where their options are spread, so the fix is a different
transformer, not different arguments. `ProcessorWrapper` — their
`MediaStreamTrackProcessor` plumbing and `canvas.captureStream` fallback — is kept.

| | |
|---|---|
| confidence mask | a float 0..1 per pixel; the model's own uncertainty at the boundary *is* the alpha |
| landscape model | 256×144, so a widescreen camera is not squashed — and 44% fewer pixels, so the quality fix and the latency fix are the same change |
| temporal smoothing | each mask blended 0.6/0.4 with the last, because segmentation is independent per frame and edges shimmer |
| feathered edge | a separable blur on the mask at 256×144, then a smoothstep |
| no CPU readback | MediaPipe is given our own canvas, so `getAsWebGLTexture()` returns a texture we can sample. A `getAsFloat32Array()` would stall the pipeline on the GPU every frame |

MediaPipe upsamples the mask to the **input** size before handing it over — measured
1280×720 for a 720p frame, not the model's 256×144. The mask render targets are still
256×144 because that is the information the model actually produced, and feathering at 720p
would blur four times as many pixels for the same edge. Checked rather than assumed: mask
targets at 640×360 give the same result to within 1%.

### What the model is confidently wrong about

Segmentation quality is not one problem. After the geometry was fixed, a real frame — a
person at a desk with an office chair behind them and a fabric throw over its back — still
kept the chair and the throw. Measured confidences, on that frame:

| region | median | above 0.80 |
|---|---|---|
| shirt | 1.00 | 99% |
| face | 1.00 | 82% |
| chair back | 0.63 | 31% |
| throw over the chair | 0.62 | 41% |
| clear wall | 0.00 | 0% |

The furniture is not noise, it is a **belief**. A throw over a chair beside a shoulder
genuinely looks like clothing, and the multiclass model agrees with the mistake: it labels
the throw `clothes` at 0.48 and the chair at 0.55. That model was fetched, run on the same
frame and rejected — 16 MB against 250 KB for no improvement.

What does work is where the alpha transition is put. `smoothstep(0.35, 0.65, …)` has its
midpoint at 0.5, so it keeps everything the model half-believes: 76% of the chair. A NARROW
transition placed just above the furniture's median cuts that to 41% for 1% of the face and
nothing off the shirt.

**Narrow, and not higher.** Pushing further looks better on that frame and is a trap. These
are the same numbers with the whole mask scaled down 20%, which is what a dim room or a
backlit window does to the model's confidence:

```
                 chair kept     face at 80% confidence
  0.35 - 0.65        76%                 83%
  0.62 - 0.75        41%                 82%     <- chosen
  0.68 - 0.88        33%                 52%
  0.75 - 0.92        30%                 17%     <- erases people in bad light
```

Reaching full opacity by 0.75 is what keeps a less-confident person solid. Erosion was
measured as the alternative and loses at both ends: 14 mask pixels of it took the chair to
36% but the face to 73%, and it costs an extra GPU pass.

Verified end to end on the deployed build by feeding that frame in as the camera — chair
40%, throw 45%, face 78%, shirt 99%, clear wall 0%.

**Honest limit.** ~40% of that chair survives and no threshold removes it: about a third of
its pixels come back at confidence ~1.0. Fixing that properly needs information the model
does not have — a background estimate accumulated over time, which is a real feature and
also a way to erase somebody who sits still. The threshold is tuned on one scene, which is
why the robustness column above matters more than the chair column.

### The bug that made all of the above look like it had not worked

The first version of this shipped with the mask **inverted and then progressively
destroyed**, which on screen was a floating head: the person's torso cut a sharp hole in the
ceiling behind them, and the torso itself was replaced by background.

Every pass sampled with `1.0 - y`. That inversion is exactly right for the one pass that
reaches the canvas — a framebuffer's row 0 is its bottom, an uploaded image's row 0 is its
top — and exactly wrong for an intermediate pass, because it makes the parity of the chain
load-bearing. Two consequences, and the second is worse than the first:

| | |
|---|---|
| **odd parity** | The mask reaches the composite through three offscreen passes: feather across, feather down, blend. Three inversions is one inversion, so it arrived upside down. |
| **the history inverted too** | The temporal blend copies the *previous* mask forward, and that copy inverted it as well. So the running average was the mask mixed with mirrored copies of itself — it did not merely tilt, it **diffused**. |

Measured on a still of a person sitting low in frame, mask means per horizontal band,
top-to-bottom, ground truth from `getAsFloat32Array` being `[0,0,4,5,11,14]`:

```
frame 1    [14,11,5,4,0,0]     the exact mirror
frame 12   [10, 8,5,4,4,4]     flattened into mush
alpha      [ 9, 3,1,2,0,0]     smoothstep floors it — the person is simply gone
after fix  [ 0, 0,4,5,11,14]   identical to ground truth, drift 0 across 12 frames
```

The lesson worth keeping: a temporal filter **amplifies** a per-pass geometry error rather
than hiding it. A single inverted frame is a wrong-looking frame; an inverted frame fed back
into an average converges on nothing. So there are now two vertex shaders — offscreen passes
pass V through untouched, and only the composite flips — and parity cannot be got wrong by
adding a pass.

### Why this needed a photograph to find

`e2e/probe-mask.mjs` is the regression guard, and it takes a photo of a person as an
argument for a reason: **Chrome's fake camera has no person in it**, so the confidence mask
is ~0 everywhere and every geometry bug looks exactly like "nothing to segment". Upside
down, half scale, averaged into mush — all identical on that input. The earlier verification
of this feature measured a flat blue frame and a colour match, and was right about both
while the mask was broken.

The probe separates three things that must agree, because two of them were fine:

1. where the person is in the input, from the pixels
2. the mask straight out of MediaPipe — the CPU ground truth
3. the mask after the app's own GPU chain, sampled the way the composite samples it

(2) was perfect the whole time. It asserts on which *half* of the picture each lands rather
than on exact values, so any photograph works and none has to be committed. Verified against
the pre-fix shader: 3 of its 6 checks fail, including the two that matter.

One earlier check in it was worthless and is worth naming: "the composite keeps a visible
region of person" passed on peak alpha alone, and the broken build peaked at 9% — a real
number, in entirely the wrong place. Where the alpha is has to be part of the assertion.

**Measured semantics, because the obvious assumption is wrong.** The selfie segmenter
emits **one** confidence channel, not one per category — verified against both models:
`confidenceMasks.length === 1`, and the value is the probability that a pixel is the
*person*. Reading it as background confidence and taking `1 - m` composites the person
into the background and the background over the person, which looks — confusingly —
exactly like the feature not working at all.

**Two bugs worth recording, because both were invisible:**

- Render targets were allocated on `canvas.width !== frameWidth`. `ProcessorWrapper`
  sizes the canvas *before* it starts piping, so that was already false on the first
  frame, nothing was allocated, and every frame threw inside the segmentation callback.
  Allocation is now keyed on what this transformer has actually allocated for.
- The catch that keeps one bad frame from tearing the track down was swallowing the
  error in silence, so a pipeline failing on every frame was indistinguishable from a
  working one with nothing to do — the camera simply passed through. It now warns once
  per session, and `init` logs one line when the segmenter attaches.

The cost is shown in the settings window next to the connection metrics
(`Background: N ms/frame`) — reported rather than asserted, because "this is faster
now" is not something to take on trust. Note what that number is: **main-thread time
per frame**, which is what causes dropped frames. GPU completion is pipelined and not
included.

---

## 8d. Latency: measured, and mostly not ours

Measured on the live deployment with `e2e/probe-latency.mjs` — two real Chromes, one
publishing and one subscribing, reading the subscriber's own `getStats`:

| stage | measured | whose |
|---|---|---|
| **network round trip** | **273–285 ms** | the internet |
| receiver jitter buffer | 8–14 ms | the browser, already below its own floor |
| frame assembly | 0.5–0.7 ms | the browser |
| decode | 0.3 ms | the browser |
| virtual background, when on | 0.6 ms of main thread | ours (§8c) |
| SFU forward | ~1 ms | LiveKit forwards, it does not buffer for playout |

The round trip is 95% of it and it is not an application number. A TCP handshake to the
same host — one round trip, no WebRTC involved — takes 268–275 ms from the same machine,
which matches. It is the distance from this client to `us-east-1`: about 135 ms each way,
and media travels client → SFU → client, so a viewer pays it twice before any code runs.

**The only change that moves a 270 ms number is moving the SFU closer to the people in the
call.** An SFU in the region nearest the audience turns 135 ms each way into 10–30 ms. No
amount of client-side tuning competes with that, and this section exists mainly to stop
anyone spending a day proving it again.

### "It says connected but the video appears 5–10 seconds later"

A different complaint from steady-state latency, and it needed its own instrument:
`e2e/probe-firstframe.mjs`. Two Chromes on one machine, so `Date.now()` is comparable between
them, and every milestone stamped inside the page rather than over CDP. It measures both join
orders, because they behave completely differently:

| | measured from | to a picture |
|---|---|---|
| **join-late** — host already publishing, viewer arrives | viewer's transport up | **~500 ms** |
| **host-late** — viewer waiting, host arrives | host's click | **~2800 ms** |

Join-late is fine and always was. Host-late is the reported one, and the breakdown localises it:

```
   1708 ms   host's transport coming up: ICE, then DTLS          61%
    472 ms   encoder producing its first frame                   17%
    623 ms   that frame reaching the viewer and decoding         22%
   -------
   2803 ms
 + 902 ms   page load and token fetch, before the click
```

With a real camera (`getUserMedia` is 300–1500 ms) and a virtual background (MediaPipe wasm),
5–10 seconds is entirely consistent with this. The probe uses a fake camera and no background,
so its numbers are a floor.

### The fix that measured worse, and why it is worth recording

The 1708 ms is a DTLS handshake to a server 264 ms away. It needs **nothing** from the
presenter, so it looked like free money: mount the room component immediately, let
`room.connect()` run while the pre-join screen is up, and publish on the click.

It made things **nine times worse** — 2.8 s became 24 s, consistently across three runs. The
console said why:

```
[warning] peerconnection failed disconnected
[warning] triggering ICE restart
[error]   publisher data channel 'DATA_TRACK_LOSSY' closed unexpectedly
```

With nothing published, the transport sits idle, and on this deployment **an idle transport
drops**. The ICE restart that follows costs about eighteen seconds. Reverted.

Two things this cost, both worth naming:

- On the way there it also exposed a bug of its own. `entryTracks` was a ref captured at mount,
  correct only because the component used to mount *after* the pre-join screen handed its camera
  over. Mounting earlier meant it captured `null`, publishing found no tracks, and the fallback
  asked for a **second camera while the first was still open**. That was most of the first 24 s
  measurement, and it was found by re-running the probe rather than by reading the code.
- `prepareConnection` remains, and is the safe version of the same idea: DNS, TLS and token
  validation, stopping short of ICE. There is no idle transport for it to lose.

### The actual root cause: the TURN relay range was never opened

Chasing "why does an idle path drop" led to the firewall, and to a misconfiguration that has
been there since the instance was built.

The evidence, in order:

1. `probe-room` showed media selected on **TCP 7881**, with the UDP candidate pair stuck at
   `in-progress` and `tx=0` — the direct UDP path was never used.
2. The same probe reported `iceServers=[]`: the client was offered **no STUN or TURN**, so it
   had no relay to fall back to.
3. UDP to the SFU is *not* blocked. A STUN binding request to `3478/udp` gets a reply in
   ~285 ms, 3 times out of 3.
4. And LiveKit's own startup line says where TURN actually puts the media:

```
"Starting TURN server","turn.relay_range_start":30000,"turn.relay_range_end":40000,"turn.portUDP":3478
```

The security group opens `80/tcp`, `443/tcp`, `7881/tcp`, `3478/udp` and `50000-60060/udp`.
**`30000-40000/udp` is not among them.** So a client behind a network that cannot do direct UDP
allocates a TURN relay successfully on 3478 — the control channel is open — and then every
relayed media packet is silently dropped. The allocation looks fine; the relay never carries a
byte.

That leaves **TCP 7881** as the only path that works, which explains the rest:

- TCP media has head-of-line blocking, so it is slower and jerkier than UDP under any loss;
- an **idle** TCP connection gets reaped by NAT and firewall state timeouts, where an idle UDP
  path would be held open by consent checks. That is why a viewer who sits in a room with no
  media flowing loses the transport, and why the ICE restart that follows costs ~20 s.

### `use_ice_lite: true` was the actual root cause

The relay range was a real gap and opening it changed nothing, which is how the real cause
surfaced. An **ICE-lite** agent is passive by definition: it answers connectivity checks and
never initiates any. On this path the client's own checks never completed the UDP pair, so
Chrome gave up on UDP and used TCP.

Setting `use_ice_lite: false` makes LiveKit a full ICE agent that probes back. Measured with
`e2e/probe-room.mjs`, same client, same network, minutes apart:

| | `use_ice_lite: true` | `use_ice_lite: false` |
|---|---|---|
| UDP pair | `in-progress`, **tx=0** | **`succeeded`, tx=1,854,218** |
| TCP 7881 | carried everything | not used |
| ICE states | …`pc:connected → ice:disconnected → pc:disconnected` | …`pc:connected` |
| host-late first frame | 24–27 s | **~3.1 s** |
| join-late first frame | ~600 ms | ~650 ms |

The third row is the one that mattered most: with UDP the connection stops dropping, so the
ICE restarts and the ~20 s waits disappear. Corroborated in the user's own room before the fix
— `error: "could not restart participant"`, three times, followed by `removing participant
without connection`.

**The trade-off, stated plainly:** ICE-lite exists to save server CPU, and LiveKit recommends
it for scale. A full ICE agent runs per-connection state for every participant, so this costs
more CPU at 500 attendees than the configuration it replaced. Correctness first — but it makes
load testing at the target size more important, not less, and that has not been done.

### The single muxed UDP port: tried, measured, reverted

`rtc.udp_port` replaces the 10,061-port range with one port for every participant. It is
LiveKit's documented production recommendation, it would have cut the firewall to one media
rule, and it would have made the `ip_local_reserved_ports` sysctl unnecessary by construction —
a pinned low port cannot collide with the ephemeral range. Every argument for it was sound.

It broke UDP. With `udp_port: 7882`, measured minutes after the working configuration on the
same client:

| | port range | `udp_port: 7882` |
|---|---|---|
| remote candidates offered | 16–24 | **8** |
| selected pair | **udp** `:55084`, tx=2,767,310 | **tcp** `:7881`, tx=1,995,057 |

The listening sockets say why:

```
UNCONN  172.17.0.1:7882      docker0
UNCONN  172.19.0.1:7882      a second docker bridge
UNCONN  10.80.3.90:7882      the host's private address
```

The mux binds **per interface** rather than to `0.0.0.0`, and on this host the interfaces it
found are two Docker bridges and a private VPC address. None is reachable from outside, so the
only UDP candidate on offer was unusable and ICE fell back to TCP — the same failure the
ICE-lite fix had just removed.

Reverted to the range, and UDP came straight back. The port range stays.

This is worth keeping in the record because the change is *still* the right end state. It needs
the mux told which address to advertise — `use_external_ip`, or an interface filter that
excludes the Docker bridges — and that is a change to test on a box where breaking media for a
few minutes is free. Two for two today on well-reasoned theories that measured worse; the
measurement is the only reason either was caught.

Still open: clients are offered **no TURN at all** (no `relay` candidate is ever gathered, and
`iceServers` carries only the configured STUN servers). It matters less now that the direct UDP
path works, but a client on a network that blocks UDP outright still has only TCP. The relay
range is open and sized for testing — 10 ports, `30000-30009` — so this is ready to investigate
whenever it becomes the limiting factor.

**The fix is a firewall rule, not code**: open `30000-40000/udp`, or narrow
`turn.relay_range_start/end` to a smaller window and open exactly that. A narrower range caps
how many simultaneously relayed participants a session can have — one relay port each — so it
trades firewall surface against capacity.

Not applied at the time of writing: it opens a port range to the internet on somebody else's
account, which is their decision to make.

**`packet_buffer_size`.** Sizes the SFU's NACK retransmission history — memory, and the
range over which a lost packet can still be re-requested. LiveKit does not hold packets to
reorder them before forwarding. `infra/ec2/livekit.yaml` used to set it to 500 with a
comment claiming it traded latency for smoothness; 500 is also the v1.9 default for video,
so the line changed nothing, and the trade it described was not the one the setting makes.

**`RTCRtpReceiver.jitterBufferTarget`.** The standard way for a page to ask for a shorter
playout buffer, and on this path it does nothing, which the probe shows two independent
ways:

- A/B/A across `null` → `0` → `null`: 9 ms, 8 ms, 8 ms. Zero drift between the two
  baselines and zero saved by the target — repeated across runs.
- `jitterBufferMinimumDelay` reports a floor of **15–17 ms** while the delay actually
  applied is **8–14 ms**. The buffer is already below the smallest value the browser will
  compute, so no target can lower it.

That floor is derived from measured jitter, which is why this generalises rather than being
a quirk of a clean link: on a jittery network the floor rises and a target of 0 still cannot
go under it. `jitterBufferTarget` is useful for the opposite request — buying smoothness by
asking for a *larger* buffer. An implementation of the low-target version was written,
measured, found to be a no-op and deleted rather than shipped as a placebo.

### The measurement stays, and is tested

The settings window shows **Playout buffer**, from
`jitterBufferDelay / jitterBufferEmittedCount` over a two-second window rather than the
session lifetime — a lifetime average is dominated by the seconds just after joining, while
the buffer is filling. It is there so that "the video is behind" can be answered with a
number: ~10 ms means the buffer is innocent and the round trip is not.

`web/lib/network.test.mts` covers `readPlayoutMs`, because it reports a number to
somebody who is troubleshooting and a plausible wrong number is worse than none. It caught
one: the first sample took its delta against zero, which is the lifetime average — so the
single reading the window logic exists to avoid was the first one anybody saw. The state now
carries a `seeded` flag, spent only on a report that actually has frames in it.

`e2e/probe-latency.mjs` is A/B/A rather than before/after on purpose. A WebRTC connection
is not in a steady state for its first seconds, and a plain before/after cheerfully credits
that settling to whatever changed in between — which is how the no-op above first looked
like a 5 ms win. The first run also needed a longer warm-up: `adaptiveStream` was still
choosing a layer, and a layer change is a new SSRC, so a phase straddling one compares two
different streams.

---

## 9. End-to-end flows

### Host: schedule → start → present

```
1  POST /api/host/webinars                 → slug, webinar id, passcode
2  POST /api/host/webinars/{slug}/start    → status=live
                                             API creates the SFU room with the
                                             attendee ceiling and seeds RoomMeta
3  POST /api/host/webinars/{slug}/join     → JWT (roomAdmin, canPublish)
4  PreJoin: check camera and mic           ← tracks opened here are handed over,
                                             not reopened, so there is no second
                                             permission prompt
5  room.connect(url, token)                → WSS, then ICE, then DTLS, then media
6  publish handed-over tracks in parallel
```

### Attendee: register → join

```
1  POST /api/webinars/{slug}/register      → join key (the credential; no account needed)
2  POST /api/webinars/{slug}/join          → JWT (canPublish=false, canPublishData=false,
                                              hidden if the host hides the audience)
                                             + the session controls at join time
3  room.connect()                          → subscribe only; nothing is published
4  GET  /webinars/{slug}/chat?since=0      → the conversation so far
5  GET  /webinars/{slug}/polls             → any open poll → PollPopup
```

### Speaking request

```
attendee taps Raise hand
   └─► data channel { kind: "hand", raised: true }
         └─► host's Participants panel shows it, and a toast
               └─► host picks:
                     "Allow to speak"  → POST …/stage { role: panelist, audioOnly: true }
                     "Bring on stage"  → POST …/stage { role: panelist, audioOnly: false }
                          │
                          ├─ SFU: UpdateParticipant → permissions change on the LIVE
                          │       connection; no rejoin
                          ├─ DB:  webinar_stage_grants → survives their reconnect
                          └─ data channel { kind: "lower-hand", reason: "granted" }
```

The host cannot start someone's microphone — only their browser can. So "please unmute"
is a *request* on the data channel, not an action.

### Session end

```
POST /api/host/webinars/{slug}/end
  ├─ DB: status = ended
  ├─ SFU: DeleteRoom            ← everyone is disconnected; leaving only the host
  │                               would leave the audience watching a dead stage
  ├─ clear stage grants         ← promotions are scoped to one session
  ├─ finalise recordings        ← "recording" becomes a downloadable file
  ├─ close open polls           ← a poll on an empty room would still accept votes
  └─ log the chat summary       ← nothing to migrate: it was never in a cache
```

---

## 9a. Gallery layouts, and what they cost in bandwidth

Three modes, chosen by the viewer. `lib/layout.ts` owns them, and it owns one more
thing that is not about pixels at all: **which video tracks this browser
downloads.** They are the same decision. A tile's size is what decides its simulcast
layer, and only the layout knows the size.

```
  speaker                  grid (paged)              spotlight
  ┌───────────────────┐    ┌─────┬─────┬─────┐      ┌──────────────┬──────┐
  │                   │    │  ▣  │  ▣  │  ▣  │      │              │  ▣   │
  │       ▣ HIGH      │    ├─────┼─────┼─────┤      │   ▣ HIGH     ├──────┤
  │                   │    │  ▣  │  ▣  │  ▣  │      │  (content)   │  ▣   │
  ├───┬───┬───┬───────┤    ├─────┼─────┼─────┤      │              │ MED  │
  │▣ L│▣ L│▣ L│  …    │    │  ▣  │  ▣  │  ▣  │      │              │      │
  └───┴───┴───┴───────┘    └─────┴─────┴─────┘      └──────────────┴──────┘
   focus HIGH,              all qualityFor(n)         content HIGH,
   strip LOW                  ‹ 1 / 12 ›              two beside it MEDIUM
                          off-page: setEnabled(false)
```

**State** (`useStageLayout`, client-side only, `localStorage`):

| | |
|---|---|
| `mode` | `'speaker' \| 'grid' \| 'spotlight'` |
| `preferences` | `hideNonVideo`, `onlySpeakers`, `pageSize` (16/25/49), `currentPage` |
| `pinnedParticipantId` | the tile this viewer locked to the main stage |

Persisted: the mode and the filters, because they are preferences. Not the page or the
pin, which are about a session that has ended.

**Nothing here is published.** No room metadata, no data channel. A viewer switching
to a grid must not reframe the session for four hundred people reading the slides.

### Paged, not virtualised

`react-window` is the reflex answer and it is the wrong one here. Recycling DOM rows
is right when rows are cheap; these rows each hold a decoding `<video>`, and the
expensive part is not the element but the stream behind it. Scrolling a virtualised
list of 300 would keep 300 subscriptions alive and hand the browser 300 decoders.
Paging bounds both: 49 elements, 49 subscriptions, everything else switched off.

### Two facts from livekit-client that shaped `applyBudget`

Read out of the shipped source rather than assumed, because both are easy to get
backwards:

- **`isManualOperationAllowed()` refuses only when the track is not subscribed** — not
  because `adaptiveStream` is on. So manual control composes with it. The reverse
  would have made the whole module pointless.
- **`isEnabled` is `requestedDisabled !== undefined ? !requestedDisabled : visible`.**
  The *first* `setEnabled` call takes the decision away from `adaptiveStream`
  permanently for that track. There is no falling back. So `applyBudget` is handed
  **every** tile, including ones the viewer's filters removed — otherwise a
  participant hidden by "hide non-video" keeps its last state, renders nowhere, and
  downloads forever with nothing left to switch it off.

The two mechanisms compose, with the smaller request winning. Measured on the
deployed build with two publishers, the same participant's camera arrives as:

```
speaker strip   180p   in a 198px slot
2-up grid       360p   in a 708px cell
spotlight side  180p   in a 288px tile
```

Our per-tile quality is a ceiling; `adaptiveStream`'s element-size request can ask for
less, and does. What this code adds is that the ceiling drops the *instant* the page
changes rather than a beat after the elements go away, and that it covers tiles which
have no element for `adaptiveStream` to measure.

### Smart sort

Order matters more than it looks, because with pagination the tail of the list is what
stops being downloaded — getting it wrong unsubscribes from whoever is talking. Pinned,
then screen shares, then active speakers, then host → panelists → promoted attendees,
then cameras-on before cameras-off, then identity for stability. Without that last key
the grid reshuffles on every audio-level update and nobody can click anything.

### How the 300-participant behaviour is verified

Not in a browser — it cannot be, without 300 browsers. `web/lib/layout.test.mts` drives
the four pure functions directly (`make test-web`; Node runs the TypeScript, so there is
no test runner and no build step to keep in sync). 350 checks, and the ones that earn
their place:

- 300 tiles at each page size render exactly `pageSize` and never more than 49.
- Walking every page shows every tile exactly once — no gaps, no duplicates.
- A page index past the end clamps, because it outlives the list it indexed.
- **300 participants, 25 subscribed, 275 explicitly switched off** — including tiles the
  viewer's filters removed, which is the property that keeps `adaptiveStream`'s handover
  from leaking streams.

The suite was mutation-checked: breaking the off-page disable, the page clamp, or the
sort's identity tiebreak each makes it fail. The stability test needed strengthening to
manage the third — its first version compared a fixture against its own reverse and
passed with the tiebreak deleted, because no two tiles in it were equal on every earlier
key, so the tiebreak was never reached.

---

## 9c. Screen-share audio

A presenter played a YouTube video over a screen share and the audience saw it in silence.
Sharing a *recorded file* did carry sound, which is the clue that identified the fault: the file
path in `lib/file-share.ts` publishes `Track.Source.ScreenShareAudio` explicitly, and the
audience hears it — so the receive side was already correct and `RoomAudioRenderer` already
plays that source. Nothing was being captured.

`SCREEN_SHARE_OPTIONS` had `audio: false`, defended in a comment on the grounds that presenters
share slides and terminals more often than video. True, and irrelevant: a slide has no sound to
lose, so asking for audio costs a slide-sharer nothing, while a video-sharer without it has no
way to succeed.

### Three things had to change, not one

**Capture it.** `audio` is now an options object rather than `true`, because the three defaults
that come with a `getUserMedia`-style audio capture are all microphone processing and each one
damages music: echo cancellation subtracts what it believes is a loop, noise suppression removes
steady tones — which is what a bassline is — and automatic gain control pumps the level between
quiet and loud passages. All three are explicitly off.

**Publish it as music.** `publishDefaults` tunes audio for speech: `AudioPresets.speech` is
24 kbps mono, and DTX stops transmitting during silence. The SDK merges `publishDefaults` into
every publish, so a shared soundtrack would have gone out as a phone call with its quiet
passages cut. `setScreenShareEnabled` takes a third argument for exactly this, and
`SCREEN_SHARE_PUBLISH` overrides the audio keys plus the **video codec**: Chrome often encodes
`getDisplayMedia` as H264 while the room default is VP8, and the SFU only attaches a receiver
for codecs listed on `AddTrack` — H264-on-the-wire with VP8-only in `codecs` yields
`could not find codec for webrtc receiver` / `isReceiverAdded: false`. Encoding bitrate and
simulcast layers still come from `publishDefaults` (`screenShareEncoding` / `SHARE_LADDER`).
Stereo is not forced: the SDK reads the capture's channel count, which is the honest answer.

**Record it.** `AudioMixer` in `lib/recorder.ts` collected `Track.Source.Microphone` only, so a
recording of a session where the host played a video preserved the same silence in the file —
and a shared clip is usually why the recording exists. It now collects screen-share audio too,
keyed by `identity:source` rather than by identity, because one participant can be a microphone
and a shared video at the same time and keying on identity alone had the second overwrite the
first.

### The part that is not a bug and cannot be fixed in code

Browsers do not all let a page have the audio of an arbitrary surface:

| shared surface | audio |
|---|---|
| a Chrome tab | yes, every desktop platform |
| a window | **not on macOS**; Windows and ChromeOS can |
| the whole screen | the same |

So a presenter on a Mac who shares their entire screen to play a video is inaudible however this
is configured, and there is no error to tell them — the share simply works, silently. The only
available fix is to say so before the choice is made, which the share picker now does, with the
sentence chosen from the platform (`SHARE_AUDIO_SURFACES`). Measured on macOS: *"On macOS a
window or the whole screen cannot carry sound at all — only a tab can."*

### What was verified, and what was not

The capture request was read back by shimming `getDisplayMedia` on the deployed build:

```json
{"audio":{"echoCancellation":false,"noiseSuppression":false,"autoGainControl":false},
 "video":{"displaySurface":"browser","width":{"ideal":1920},"height":{"ideal":1080},"frameRate":30},
 "selfBrowserSurface":"exclude","surfaceSwitching":"include"}
```

Sound actually arriving at an audience member is **not** verified here: headless Chrome cannot
capture real tab audio, so there is nothing for the harness to hear. The evidence that the
receive path works is the file-share case, which uses the same track source and always worked.

---

## 9b. Sharing a recorded video as if it were live

The presenter can share a video file — from their disk, from this webinar's own
recordings, or from Google Drive — and the audience cannot tell it is not live.

```
  HOST'S TAB                                        EVERY PARTICIPANT
  ┌────────────────────────────────────┐
  │ hidden <video>  ← file / recording  │
  │   │                                 │
  │   ├─ captureStream() ──► video ─────┼──► published as ScreenShare
  │   │                                 │         │
  │   └─ MediaElementSource ─► dest ────┼──► published as ScreenShareAudio
  │                     └─► speakers    │         │
  │                        (monitor,    │         ▼
  │                         off by      │    ┌──────────┐      full-bleed share,
  │                         default)    │    │   SFU    │──►   normal webinar UI,
  │                                     │    └──────────┘      no player at all
  │ playback bar: ⏸ ──────── 4:12  ⏹    │
  │  (DOM around the element — never    │
  │   in the captured frames)           │
  └────────────────────────────────────┘
```

**One decision does almost all the work: publish it as the screen share.** The
alternative — hand every client the file and keep their players in step — fails the
brief three ways, each of which the audience notices. Five hundred players against a
wall clock drift and rebuffer independently, so somebody is always ten seconds behind
and the chat gives it away. The file would be needed five hundred times, and the
bandwidth arithmetic in `docs/CAPACITY.md` applies to it rather worse. And a `<video>`
element buffering, or one that can be right-clicked, is itself a tell.

Publishing one track instead means:

| requirement | how it is met |
|---|---|
| everyone at the same position | there is nothing to synchronise — one live track, the same guarantee as the presenter's camera |
| late joiners see the current position | they subscribe and receive frames from that moment, which *is* the current position. No seeking, no catch-up |
| no playback controls for participants | there is no player at their end to have controls |
| no "pre-recorded" marker | nothing downstream is told. The tile labels it "*name*'s screen", exactly as a desktop share |
| full screen | the stage already renders a share full-bleed |

**Where the file comes from**, in the order the picker offers them:

- **This webinar's recordings** — streamed straight off `…/recordings/{id}/file`, which
  already serves range requests. Nothing is copied into the tab.
- **Local disk** — an object URL. Nothing is uploaded, so there is no size limit and
  no wait; WebRTC does the distribution that an upload would have been for.
- **Google Drive** — needs `GOOGLE_CLIENT_ID` and `GOOGLE_API_KEY` (both public
  values; there is no client secret in this flow and there must never be). Google's
  own Picker, so we never enumerate the host's Drive. The file is downloaded to a
  Blob, which is the honest weak point — hence the 1.5 GB cap. Streaming it means
  proxying through our API with range support, which is the upgrade path.

Three things here are less obvious than they look:

- **Audio goes through Web Audio, not through `captureStream`.** `captureStream` hands
  back an audio track too, and whether muting the element silences it is not something
  to depend on. A `MediaElementAudioSourceNode` takes over the element's output, so the
  room hears it via the destination node and the presenter hears nothing unless they
  ask — monitoring is off by default, because a presenter on speakers feeds the file
  straight back through their own microphone.
- **The host sees their own share, unlike a desktop share.** A captured desktop
  contains the window showing the capture, so rendering it locally gives an infinite
  corridor; `tile.tsx` blanks it for that reason. A file has no such loop, and the
  presenter needs to see that the share is working — so the blanking is conditional on
  a file share not being active.
- **Stopping has to route through the engine.** `setScreenShareEnabled(false)` would
  unpublish the track and leave the video element, the AudioContext and the object URL
  behind, decoding in a tab nobody is watching.

Costs, stated: the presenter's tab must stay open and spends CPU encoding, exactly like
the browser-side recorder; and the audience sees a re-encoded stream, so the ladder in
`lib/network.ts` bounds the quality. Safari has no `captureStream` on a media element,
so the option is not offered there rather than offered and then failing after a file
has been picked.

### The picker, and what a web page cannot do

The dialog with **Chrome tab / Window / Entire screen / Share by file** tabs is
Chrome's, drawn by the browser outside the page. **A web page cannot add a tab to
it.** What a page can do is ask for a particular surface — `displaySurface` is a real
constraint and Chrome opens its picker on the matching pane — so our own dialog offers
the same four choices, the first three hand off to Chrome pre-focused, and the fourth
is ours end to end.

---

## 9d. Registration: a reachable number, a local clock, and a door

Four changes to the participant journey, all of them in the fifteen minutes around joining.

### The number

`registrations.phone`, one `text` column, E.164 (`+919876543210`). Not two columns.

The split into "dial code" and "national number" is a property of the *form*, not of the
number: `+91 98765 43210` typed into one box and `+91` picked from a list next to
`9876543210` are the same number, and keeping them apart in the schema means every reader
reassembles them and every writer has to agree how. E.164 is also what a dialler, an SMS
gateway and a CRM all expect.

Validated on shape, not by a phone-number library: `+`, then 8–15 digits after normalising
away spaces, dashes, brackets and a leading `00`. Enough to catch a missing country code
and a fat-fingered extra digit, and no more — a library that knows Indian mobile prefixes
is a library that rejects a valid number the week a new range is allocated.

The picker is `lib/dial-codes.ts`: ~200 countries, dial codes only. Country *names* come
from `Intl.DisplayNames` in the viewer's own language, because a hardcoded English list
would be both larger and worse. It opens on the browser's own region, so most people never
touch it.

The CSV export writes `\t+919876543210`. Without the tab, Excel and Sheets read a bare
`+91…` as a formula and mangle it.

### The clock

Two separate things that are easy to conflate:

| | where | value |
|---|---|---|
| the instant | `webinars.starts_at`, `timestamptz` | **UTC**, always, whatever is written |
| the display zone | `webinars.time_zone`, `text` | **Asia/Kolkata** by default |

Postgres stores a `timestamptz` as UTC internally regardless of the offset in the input, so
the database half needed no change at all — only the *default display zone*, which was UTC
and is now IST in both places that decide it: `defaultTimeZone` in `api/internal/api/host.go`
and `DEFAULT_TIME_ZONE` in `web/lib/format.ts`. UTC is right for nobody who attends.

`tzLabel` was printing `GMT+5:30`. Correct, and not what anyone calls it. It now formats the
zone name in `en-IN` with `timeZoneName: "short"`, which yields `IST` for Asia/Kolkata and
falls back to a plain offset (`GMT-4`) for zones CLDR has no abbreviation for — an
improvement with no lookup table to go stale. The locale is pinned, like every other
formatter in that file, because a label that differs between the server render and the
browser is a hydration mismatch on a page that looks fine.

The API had one server-rendered clock time, in the too-early refusal, and it said UTC. It
now uses `localTime(at, wb.TimeZone)`, so the sentence an attendee reads at the moment they
are turned away is in the webinar's own zone with the zone named:

```
This webinar hasn't opened yet. You can join from 15:41 on 8 September 2026 EDT.
```

### The door

`joinGrace = 15 * time.Minute`, in `api/internal/api/join.go`. Fifteen minutes before the
scheduled start the audience is let in; before that the join endpoint answers **409
`too_early`**, not 403 — the request is well-formed and the caller is who they claim to be,
it is the webinar's state that says no, and the UI has to tell "come back later" apart from
"you are not allowed".

Three deliberate exceptions:

- **A host or panelist is never subject to it.** Setting up a camera an hour early is what
  a practice session *is*.
- **Once `status == live` it stops applying entirely.** A webinar that starts late must not
  lock out the people already waiting for it.
- **An unparseable `starts_at` opens the doors.** A parsing bug in our code is not a reason
  to keep an audience out of a webinar that is happening.

### After registering: a button, or a countdown that becomes one

`JoinGate` in `components/register-form.tsx`. When the doors are open it is a **Join now**
button. When they are not it is a live countdown — *Doors open in 2 hr 40 min* — plus the
absolute local time.

A static sentence sat here first, and it had two faults. It read as a refusal rather than a
wait, and it was frozen: somebody who registered ten minutes early sat looking at it while
the doors opened behind it, because nothing re-rendered until they reloaded a page they had
no reason to reload. The countdown ticks, and at zero it swaps itself for the button with no
reload.

The tick rate is not constant — 1 s inside the last two minutes, 20 s otherwise. A
countdown reading "in 2 days" redrawn every second is 86,400 renders to change one digit.
`now` starts `null` and is set in an effect, never during render: `Date.now()` in a render
differs between server and browser, and this component is reached both ways.

### How all of this was checked

Three probes, because the three claims fail differently.

`api/probe-live.sh` — the server's behaviour, against the live deployment. Creates its own
host and two webinars (one 10 minutes out, one 60), asserts the E.164 round trip, the three
rejection messages, 409-then-200 across the window, and that the public payload carries what
the gate needs and not the passcode. Deletes both webinars and reports what it left behind.

`e2e/probe-register.mjs <slug> open|closed` — the page, in a real Chrome over raw CDP. Fills
the form and submits it, then asserts the dial picker is populated and non-blank, the phone
input is `type=tel` and `required`, and that the confirmation shows a live **Join now** when
the doors are open and a *Doors open in* countdown when they are not — and that no host
vocabulary (Browse webinars, Registrants, Start webinar, Webinar ID…) appears at either
step.

`web/lib/format.test.mts` — 35 checks on the zone helpers, including the wall-clock→instant
round trip across both DST transitions in `America/New_York`, which is unreachable by hand.

Three of these checks earned their keep by failing:

- The first version of the shell probe sent `{"name": …}` where the API wants
  `firstName`/`lastName`, so **every** registration was rejected with a decode error — and
  the three "invalid phone rejected" assertions passed on it. A negative that only checks
  the status code passes for a typo in the payload. They now assert the 400 **and** that
  the complaint is on the `phone` field, and there is a positive control beside them.
- The countdown check matched `/\d+\s*(min|hour|day)/`, which also matches the "45 min"
  duration in the summary above it — it passed on a page with no gate at all. It now
  anchors on the gate's own heading.
- `format.test.mts`'s "a nonsense zone does not throw" found that the new `tzLabel` threw a
  `RangeError` out of its own `catch`, straight into a component render.

---

## 9e. Deleting a webinar deletes the webinar

Three kinds of thing have to go, and only the first was happening.

**1. The rows.** `ON DELETE CASCADE` on all seven child tables — registrations, chat messages,
polls, poll votes (via polls), recordings, panelists, stage grants, custom questions. The
cascade is declared in the migrations and deliberately *not* re-implemented as DELETE statements
in the handler: a table named in Go is a table the next migration forgets.

**2. The bytes.** Nothing cascades into a filesystem or a bucket. The old code collected chat
image keys and deleted those — and knew nothing about recordings, so **every deleted webinar
left its recording files on disk for ever.** On an instance where a two-hour session is a
gigabyte, that is the difference between a tidy delete and a disk that fills up with files no
row references. Both kinds are now collected in one `UNION ALL` inside the deleting transaction.

**3. The live session.** If people are in the room when the host presses delete, the SFU still
has a room and they are still in it — connected to a webinar that no longer exists, with chat
and polls answering 404 until the empty-room timeout. `DeleteRoom` is now called first.

Order matters: room, then rows, then bytes. Ending the session first means nobody holds a token
for a webinar mid-delete. Deleting bytes last means a storage failure cannot leave rows pointing
at files that are already gone, which is the one direction of inconsistency a user sees — as a
broken download.

### What changed in the policy, and why

Deleting used to be refused for any webinar that was live or ended, with the message *"its
registrations are the attendance record"*. Combined with a **Delete** button that only appeared
on drafts, the result was that most webinars could not be deleted from anywhere in the product.
That is now allowed in every status, and the button is on every row and on the manage screen.

The warning moved into the dialog instead, where it belongs, and it is specific per status
(`lib/webinar-delete.ts`): a draft says only that the setup goes; a live one says everyone in
the room is disconnected immediately; an ended one says this is the only record of it and the
attendance report goes with it. The registrant count is included when there is one, because
"48 registrants lose access" is a different decision from "nobody has registered yet".

Ownership is unchanged and is now the only thing in front of the endpoint: owner-only, enforced
by `requireOwnership`. Worth stating because the status guard, while never access control, did
mean the most destructive version of this — deleting a webinar with an audience in it — was
unreachable. It is reachable now.

### The counts are the evidence

`DeleteWebinar` returns what it removed, counted *inside* the transaction, and the handler logs
one line:

```json
{"msg":"webinar deleted","slug":"del-probe-1788895713","was":"live","registrations":1,
 "chat_messages":1,"polls":0,"poll_votes":0,"recordings":1,"panelists":0,"stage_grants":0,
 "questions":0,"files":1,"files_left_behind":0}
```

Counting before the delete in a separate query would report what was there a moment ago rather
than what went, and a registration arriving between the two would be deleted uncounted.

### How it was checked

`TestDeletingAWebinarRemovesEverything` builds a webinar with a row in every one of those
tables plus a recording file and a chat image on disk, deletes it over HTTP the way the host's
button does, and then goes looking with SQL and `filepath.WalkDir`. It asserts every count is
**non-zero before** the delete — without that it would pass just as well against a webinar that
never had any of it, which is how a cleanup test ends up counting to zero twice.

Verified to fail: removing the recordings half of the union leaves
`1 file(s) left in storage: [65/dd/65ddbc32-….webm]`, which is precisely the bug that shipped.

Confirmed live on a **live** webinar: rows gone, the `.webm` gone from the `webcast_recordings`
volume, `files_left_behind: 0`, and both the host and public URLs answering 404.

---

## 10. Recording

Browser-side, by design: `MediaRecorder` in the presenter's tab captures the composited
stage and uploads chunks. No server-side transcoding, no headless-Chrome egress fleet.

```
POST   …/recordings              → claims the single active slot (partial unique index)
POST   …/recordings/{id}/chunks  → appended to object storage as they arrive
POST   …/recordings/{id}/complete→ status = ready
GET    …/recordings/{id}/file    → range requests, so a browser can scrub
```

**Who may record: the host and the panelists, and nobody else.** All of the above sits
behind `requireStage`, which wants an *account* on the webinar's stage roster. That is a
narrower thing than being on stage: an attendee the host promoted publishes exactly like
a panelist and has no account at all. So the server answers the question directly in
`JoinResponse.canRecord` and the button is drawn from that — deriving it from publish
permission gave a promoted attendee a control whose every request came back 401, and
showed the control on an instance with recording turned off.

The compositor lays tiles out at **16:9 and centres the block**, letterboxing the
leftover. Dividing the canvas evenly is the obvious thing and it is wrong: two people on
a 16:9 frame gives two 640×720 cells, so a camera filling one loses half its width. And
every tile is **clipped** to its box — `cover` scales an image to be larger than its box
by definition, and a canvas draw is bounded by the canvas, not by the rectangle it was
computed from. Without the clip each tile painted over its neighbours and the last one
drawn won.

`recording: true` in `RoomMeta` reaches every client from the *server*, not from whoever
pressed the button — being recorded without being told is the kind of thing people sue over.

Storage is behind `media.Store` (opaque keys, append, seekable read). Local disk today,
S3 by adding one type. Chat images use the same interface.

---

## 11. Deployment

```
one EC2 t3.medium · us-east-1b public subnet · Elastic IP 3.82.201.244
  https://3.82.201.244.sslip.io          ← real Let's Encrypt cert, no DNS to manage
  wss://sfu.3.82.201.244.sslip.io

ports  443, 80 (ACME)  ·  7881/tcp  ·  50000-60060/udp  ·  3478/udp
```

`sslip.io` maps `<ip>.sslip.io` to that IP, so certificates work with no DNS setup.

**The region is the latency.** `us-east-1` is ~135 ms away from the machine this was
measured from, and media crosses it twice — client → SFU → client — so a viewer pays ~270 ms
before any code runs. That is 95% of the end-to-end delay and no client-side setting touches
it (§8d). Moving the SFU to the region nearest the audience is the whole fix: `ap-south-1`
for an Indian audience turns 135 ms each way into 10–30 ms. Nothing else in this document
buys anything comparable.

Images are built locally for `linux/amd64`, pushed to ECR (`webcast-temp`), and rolled out
over SSM Session Manager — there is no SSH key on the instance. Deploying the frontend
alone (`--no-deps web`) leaves Postgres and the SFU up, so nobody in a live session is
disconnected; changing `livekit.yaml` requires an SFU restart, which does drop everyone.

**`infra/ec2/livekit.yaml` is a TEMPLATE, not the deployed file.** It carries
`__PUBLIC_IP__` and `__TURN_DOMAIN__`, which provisioning substitutes. Copying the repo
copy onto the instance verbatim replaces a working config with placeholders — and because
the SFU reads the file only at startup, nothing breaks until the next restart, which is the
worst possible time to find out. Substitute on the way in:

```sh
sed 's|__PUBLIC_IP__|3.82.201.244|g; s|__TURN_DOMAIN__|turn.3.82.201.244.sslip.io|g'
```

and check `grep '__' livekit.yaml` comes back empty afterwards.

**LiveKit rejects unknown config keys outright**, so validate before deploying:

```sh
docker run --rm -v /tmp/livekit.yaml:/etc/livekit.yaml:ro \
  -e LIVEKIT_KEYS="k: $(head -c 32 /dev/urandom | base64)" \
  livekit/livekit-server:v1.9 --config /etc/livekit.yaml
```

Current state: `AUTH_BYPASS=false`, so the login page applies and no guest accounts are
provisioned. Recording enabled, disk-backed.

---

## 12. Where to look when something breaks

| symptom | look at |
|---|---|
| connects then no media | `DESIGN.md` §4.5 — the establishment ladder. Then `docker compose logs livekit` for the selected candidate pair |
| media works then degrades ~10 min in | not the app — `NetworkBandwidthOutAllowanceExceeded` in CloudWatch. See `docs/CAPACITY.md` |
| attendee sees "Connecting…" forever | `node e2e/probe-room.mjs <url> 45` with `PROBE_AS=attendee` |
| host sees the attendee's empty-stage copy | `join.canPublish` must be checked *before* live permissions, which are unknown until connected |
| chat missing after a reload | `GET /webinars/{slug}/chat?since=0` directly. If the row is there, it is a client merge problem |
| poll didn't appear for attendees | the `polls-changed` nudge, then `pollsEnabled` in the controls |
| promoted person has a dead mic button | the `promoted` metadata flag vs `allowUnmute`, which *Mute everyone* latches off |
| a shared video has no sound | on macOS, only a Chrome TAB can carry audio — not a window, not the whole screen. §9c |
| shared audio sounds like a phone call | `SCREEN_SHARE_PUBLISH` is not being passed, so the speech preset applies. §9c |
| host "is sharing" but attendees see no frames | SFU log `could not find codec for webrtc receiver` with mime H264 and codecs=[vp8]. `SCREEN_SHARE_PUBLISH` must register H264 (Chrome's getDisplayMedia path). §9c |
| a recording has the video but not its sound | `AudioMixer` must collect `ScreenShareAudio`, not just `Microphone`. §9c |
| a participant can see host navigation | the page is rendering `TopNav` instead of `ParticipantHeader`. §5b |
| a panelist cannot reach the stage they were invited to | `/host/<slug>/room` must NOT require `canHost` — the API decides. §5b |
| a host URL renders then errors | middleware is not matching that path; check the matcher in `middleware.ts`. §5b |
| a passcode does nothing | it is enforced in `validateRegistration` only, because registration is the only place a join key is minted. §5a |
| an attendee cannot join yet | `joinGrace` — the doors open 15 minutes before `startsAt`, or the moment the host starts. §5a, §9d |
| a time on screen looks hours off | the *display* zone, never the stored instant — `starts_at` is `timestamptz` and therefore UTC. Check `webinars.time_zone`. §9d |
| a zone reads `GMT+5:30` instead of `IST` | `tzLabel` formats the zone name in `en-IN`; a bare offset means CLDR has no abbreviation for that zone. §9d |
| a refusal message quotes the wrong clock | `localTime(at, wb.TimeZone)` in `api/internal/api/host.go` — the only server-rendered clock time in the product. §9d |
| "Join now" missing after registering | `JoinGate` shows a countdown until `startsAt - 15 min`; before the first tick `now` is null and it shows "—". §9d |
| a phone number arrives mangled in Excel | the CSV writes a leading tab; without it a bare `+91…` is read as a formula. §9d |
| tiles jump around when people talk | `sortTiles` must not read `isSpeaking`. The property test in `layout.test.mts` catches it. §8b1 |
| several tiles have a green border at once | a tile is reading `useIsSpeaking` again instead of `useActiveSpeaker`. There is one identity, by design. §8b1 |
| the border strobes between two people | `SWITCH_MS`/`CLEAR_MS` in `lib/speaker.ts`. Symmetric thresholds blink through one paragraph. §8b1 |
| the border never appears | `ActiveSpeakerProvider` has to be inside `RoomContext.Provider` — it reads `room.activeSpeakers`. §8b1 |
| your own camera looks mirrored to you | deliberate, and it now matches the joining preview. Nobody else's is. §8b1 |
| a deleted webinar's recordings are still on disk | the storage-key `UNION ALL` in `DeleteWebinar` — chat images alone was the old bug. §9e |
| people stay in the room after a delete | `DeleteRoom` runs first, and only for a live webinar. §9e |
| Delete is missing on a webinar | it is on every status now, list and manage screen. If absent, `readOnly` is set — that row is somebody else's. §9e |
| a green test run that proves nothing | the API suite SKIPS without `TEST_DATABASE_URL`. Look for `SKIP`. §5a |
| no Record button for a panelist | `canRecord` in the join response. False unless the account is on the stage roster *and* the instance has recording storage |
| recorded tiles cropped or overlapping | the compositor's grid — `gridFor` and the clip in `drawInto` (`lib/recorder.ts`) |
| background never starts | `/mediapipe/wasm` must be reachable from the browser; check `public/mediapipe/README.md` |
| background silently does nothing | the console. `[background] segmenter ready` means it attached; a `[background] frame processing failed` warning names the real fault. §8c |
| the person is cut out and the background shows through them | mask polarity — the confidence mask is the PERSON's probability, not the background's. §8c |
| a floating head, or the background sharp in one band | the mask is inverted. Every GPU pass that samples with `1.0 - y` inverts; only the composite may. `node e2e/probe-mask.mjs <photo>`. §8c |
| furniture next to the person is not replaced | the model believes it is clothing. `MASK_LO`/`MASK_HI` in `segmenter.ts` is the lever, and raising it too far erases people in dim rooms. §8c |
| the person vanishes in a dim room | `MASK_LO` is too high for how sure the model is. §8c has the measured trade |
| "Share by file" tab is disabled | no `captureStream` on a media element. Safari, or a very old Chrome |
| "You were disconnected" on a brief network blip | should now be a *Reconnecting… (n of 4)* banner. If it is terminal, the ladder was exhausted or the reason was not `lost`. §8a1 |
| a session that reconnects for ever | `STABLE_MS` — attempts are only forgiven after the connection holds for 30s. §8a1 |
| media on TCP after a LiveKit config change | check the selected pair with `probe-room`. `udp_port` binds per-interface and advertises Docker bridge addresses; the port range does not. §8d |
| a slow first retry after a failed join | `RECOVERY_BACKOFF_MS[0]` is 250 ms, deliberately short — the initial-connect failure is usually "the network was not ready yet". §8a1 |
| the presenter cannot pick a resolution | deliberate — see §8a. `Sending` in the settings window says which rung the app chose |
| video quality keeps changing | the ladder is oscillating; check the margins in `judge()` hold the step property. §8a |
| quality drops early in a call and never recovers | the RTT ratchet. `judge()` must compare `rtt − floor`, never an absolute figure. §8a |
| **Round trip** looks alarming but nothing is wrong | compare it with **Best round trip** in the settings window. Equal means distance, not congestion. §8a |
| the speaker is soft while the big tile is sharp | the highlighted speaker's layer is floored at MEDIUM in `wanted`; a thumbnail otherwise gets LOW. §8a |
| a host sees a big picture of themselves | `sortTiles` prefers remote over local *within* a role. §8a |
| video is smooth but a beat behind the speaker | **Round trip** in the settings window, not the app. Playout buffer is ~10 ms on this deployment; RTT is ~280 ms. `node e2e/probe-latency.mjs <url>` for the full breakdown. §8d |
| "connected" but no picture for seconds | `node e2e/probe-firstframe.mjs <url>` — it splits the wait into transport, encoder and network. ~2.8 s host-late, ~500 ms join-late. §8d |
| a picture that takes ~20 s, or an ICE restart in the console | an idle transport was dropped. Do not connect before there is something to publish. §8d |
| media on TCP 7881 instead of UDP | `use_ice_lite` must be **false**, or the SFU never probes back and the UDP pair never completes. §8d |
| a viewer's connection drops when nothing is playing | same cause: idle TCP gets reaped where idle UDP is held open by consent checks. §8d |
| `could not restart participant` in the SFU log | an ICE restart on a dead TCP path. Check the selected candidate pair is UDP. §8d |
| no `relay` candidate in the browser | clients are offered no TURN. Open item; only bites a client that cannot do UDP at all. §8d |
| grid keeps downloading a hidden participant | `applyBudget` must be handed every tile, not just the page. §9a |
| layout switcher does nothing for one viewer | it is per-viewer by design — `localStorage`, `webcast.stage-layout.v1` |
| shared file plays for the host, black for everyone | capture started before metadata arrived. `lib/file-share.ts` waits for `loadedmetadata` and non-zero dimensions first |
| Drive option says "not configured" | `GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` unset, or the Picker API not enabled on that Google project |

**A picture of all of this:** `docs/webcast-architecture.excalidraw` — open it at excalidraw.com
(File → Open) or with the VS Code Excalidraw extension. Four bands: the deployment topology and
its ports, the publisher/subscriber media model, the three separate journeys and where each is
gated, and the known limits. It is generated by `docs/make-diagram.py` rather than hand-drawn,
so re-run that after an infrastructure change instead of nudging boxes.

Diagnostics worth knowing:

```sh
node e2e/probe-room.mjs https://3.82.201.244.sslip.io 45   # real Chrome, prints the ICE pair
make test-api                                              # needs TEST_DATABASE_URL, or it silently skips
./api/probe-live.sh                                        # the live API: phone, zones, join window
node e2e/probe-register.mjs <slug> open|closed             # the live registration page in real Chrome
```

Both live probes create their own data and delete the webinars they made. They each leave one
`@example.invalid` account behind and say so; that is the one thing to clear up afterwards.

**Deploying to the instance is `.env`, not a tag.** `/opt/webcast/docker-compose.yml` reads
`API_IMAGE` and `WEB_IMAGE` from `/opt/webcast/.env`. Pushing a new image and re-tagging it
locally does nothing: `docker compose up -d` sees an unchanged config, prints `Container …
Running`, and leaves the old build serving. Point the two variables at the new tags first.
Confirm with `docker inspect -f '{{.Config.Image}}' webcast-api-1` rather than with the
compose output, which says `Running` in both cases.

---

## 13. Honest limits

Things that are **not** true today, so nobody plans around them:

- **500 participants will not work on this instance.** ~1.4 Gbps sustained egress against a
  0.256 Gbps baseline. `docs/CAPACITY.md` has the arithmetic and the instance sizes.
- **One room lives on one SFU node.** OSS LiveKit assigns rooms to nodes; it does not split
  a room. Adding nodes buys concurrent *sessions*, not a bigger session.
- **No pre-join background picker.** Choosing one before joining would need a PreJoin
  variant, so on first use there's a brief window while the model loads.
- **Simulive and recurring webinars** are a `kind` column and a form field, nothing more.
- **No load test has been run.** At 100/300/500 the result is predictable from the
  arithmetic; measuring on this instance would measure the NIC throttling.
- **~275 ms of round trip is unavoidable from where this is deployed**, and it is 95% of the
  perceived delay. It is distance to `us-east-1`, not the app: measured identically by a TCP
  handshake and by WebRTC, with the playout buffer at 10–14 ms and decode at 0.3 ms. There is
  no client-side fix and none is attempted — §8d records the one that was tried, measured and
  removed. The fix is an SFU in the audience's region.
