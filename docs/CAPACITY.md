# Capacity: what actually limits a 500-person webinar

Measured against the current deployment — one `t3.medium` at `3.82.201.244` running
Caddy, Next, the Go API, Postgres and LiveKit v1.9.12.

The short version: **egress bandwidth is the wall, and the instance is undersized for 500
by roughly five times.** Not CPU, not sockets, not the database, not the signalling layer.
Everything below is the arithmetic for that claim and what follows from it.

## The shape of the load

A webinar is not a meeting, and the asymmetry is the whole story. Attendees hold
`canPublish: false` and `canPublishData: false`, so they send nothing at all.

| | count | each | total |
|---|---|---|---|
| **Ingress** — publishers | 5 (host + 4 panelists) | 3 simulcast layers ≈ 2.35 Mbps + audio 48 kbps | **≈ 12 Mbps** |
| **Egress** — subscribers | 500 | see below | **≈ 1.1–1.5 Gbps** at `full` |

Ingress is a rounding error. One publisher's three layers are sent once to the SFU
regardless of how many people are watching — that is what the SFU is for, and it is why a
mesh topology was never on the table: at 500 participants a mesh would ask each publisher
for 499 copies of their own stream.

What one subscriber receives, in the common case of a screen share on stage with three
camera thumbnails floating over it:

```
screen share, top layer (h1080fps15)   5 000 kbps   ← the CEILING, not a fixed cost
3 camera thumbnails, 180p layer        3 × 200 =  600 kbps
audio — DTX means only the speaker sends  ≈ 100 kbps
                                       ─────────────────
                                          ≈ 5.7 Mbps  worst case
```

**The share is 1080p and adaptive, which is not the same as 1080p and expensive.**

It was pinned to 720p for a while to bound egress. That worked and was the wrong trade: it
made every share worse for everybody, including the presenters on a good uplink, who are
most of them. `SHARE_LADDER` in `lib/network.ts` now moves the top layer on the same signals
that already drive the camera — but with a higher bar (`judgeShare`) and Zoom-like content
bitrates (1080p ~5 Mbps, 720p floor ~3 Mbps):

| tier | share top layer | what a subscriber sees |
|---|---|---|
| `full` | 5 000 kbps | 1080p at 15fps |
| `reduced` | off (720p @ 3 Mbps) | 720p at 15fps |
| `minimal` | off (720p @ 3 Mbps, 8fps) | 720p, frames cut first |

**The resolution never drops below the 720p desktop floor; only the framerate does on
`minimal`.** That inversion is deliberate and it is specific to a screen share:
`contentHint: "text"` tells the encoder to hold pixels and drop frames, so a squeezed
share becomes a slower slideshow of legible text. Dropping to 360p instead would make the
text unreadable at any framerate, and reading it *is* the content. The camera ladder does
the opposite — `maintain-framerate` at 720p@~2.4 Mbps — because a sharp face at 8fps reads
as a broken connection.

Camera + share on one uplink: while a share is live the camera ladder is capped at
`reduced` (no 720p face layer) so slides own the budget.

**Geography remains a residual limit.** Zoom terminates near the client; this deployment's
media path is a single EU SFU. India clients at ~140–200 ms RTT will still see more
congestion sensitivity than a nearby PoP, even when encode budgets match.

`needKbps(tier, sharing)` counts the share in the budget. It did not before, and that was a
real bug rather than an omission: a presenter sharing at 1080p on a 3 Mbps link was judged
against the camera's need alone, so `tooNarrow` stayed false on a link that was already
saturated and the ladder never moved. (The uplink *estimate* is no longer a ladder signal —
see `judge` / `judgeShare`.)

Cameras only, no share: ≈ 3.2 Mbps at `full` (180+360+720).

So 500 subscribers is **~2.5–2.9 Gbps** at `full` share and lower once the ladder has
stepped a struggling presenter down. Size for the ceiling — a presenter on good wifi is the
normal case, not the exception.

## Against the instance

`t3.medium` network performance is "up to 5 Gigabit" — that is the **burst** figure, drawn
from a credit balance. The sustained baseline is **0.256 Gbps**.

| participants | egress needed | vs 0.256 Gbps baseline |
|---|---|---|
| 100 | ≈ 0.3 Gbps | just over the line |
| 300 | ≈ 0.9 Gbps | 3.6× over: bursts, then throttles |
| 500 | ≈ 1.5 Gbps | 6× over: throttles within minutes |

Figures at `full`. The ladder brings a struggling presenter down to roughly half of these,
but it reacts to the PRESENTER's uplink, not to the server's — so it is not a capacity
control and must not be treated as one. Nothing in the client knows the NIC is saturated.

A 60-minute session at 1.5 Gbps is far outside any credit budget. The failure mode is the
nasty kind: the first ten minutes look perfect, then the NIC throttles and everyone's
video degrades at once — which reads as "the app broke" rather than "the instance ran out
of bandwidth".

CPU is the second constraint and it is not close. LiveKit forwards without transcoding, so
the per-subscriber cost is packet rewriting: roughly 1 core per 300–400 Mbps forwarded, so
1.5 Gbps wants 4 cores against the 2 burstable vCPUs here.

### What to run instead

Pick for **sustained** bandwidth, not burst:

| target | instance | baseline | note |
|---|---|---|---|
| 100 | `t3.large` | 0.512 Gbps | 2× headroom |
| 300 | `c5n.large` | ~3 Gbps | 4 vCPU, network-optimised |
| 500 | `c5n.large` | ~3 Gbps | 2× headroom on both axes |
| 500 + recording | `c5n.xlarge` | ~5 Gbps | recording competes for CPU |

`c5n` rather than `c5`: the `n` variants have genuinely higher sustained network
throughput, which is the axis that binds here.

## Horizontal scaling: an important correction

The brief asks to "distribute rooms across multiple SFU worker nodes when participant
counts approach 100, 300, 500". **That is not how open-source LiveKit scales, and the
distinction matters before anyone provisions three nodes.**

Multi-node LiveKit uses Redis to assign a **room** to a **node**. One room lives entirely
on one node. Adding nodes therefore buys **more concurrent sessions**, not a bigger single
session — a 500-person room is on one node whether the cluster has one node or ten.
(Splitting a room across nodes needs SFU-to-SFU relay, which is a LiveKit Cloud feature,
not in the OSS server.)

So there are two different problems and they have different answers:

- **One big session** → vertical. A larger instance, which is the table above.
- **Many sessions at once** → horizontal. Redis plus N nodes, and it works well.

### And no load balancer in the media path

This was settled with measurements earlier in this project, and it is worth not
rediscovering: media cannot go through an AWS NLB. UDP target groups force
`preserve_client_ip` on and it cannot be disabled, so the SFU replies directly to the
browser and those replies leave via the NAT gateway with the wrong source address, which
browsers discard. Measured browser-side as `tx=751140 rx=0` — a connection that looks
established and carries nothing.

LiveKit's own multi-node design agrees: nodes advertise their own public addresses and
browsers connect straight to them. The load balancer, if any, is only in front of
**signalling** (`/rtc` WebSocket), never the media. `infra/ec2/livekit.yaml` has the
`redis:` block commented with this note.

## Signalling and the backend

Also worth stating plainly, because the brief assumes work here that turns out not to be
needed:

- **Signalling is LiveKit's own WebSocket**, one per participant, terminated by the SFU.
  There is no separate socket server to cluster. Redis would be needed for multi-node
  routing, not for socket capacity — a single LiveKit node handles thousands of signalling
  connections, and 500 is not a number it notices.
- **Chat, reactions, Q&A and polls do not use sockets at all.** Attendees have no
  data-publish grant; they POST to `/say`, and the server broadcasts over the SFU's
  existing data channel. So the "event loop blocking under high-concurrency spikes" risk
  does not exist in the shape the brief imagines — there is no per-event socket fan-out in
  our process.
- **Backpressure is already in place**: a per-sender budget of 90 messages/minute
  (`sayPerMin`), keyed on the participant identity rather than the IP, because an entire
  corporate audience shares one egress address and a per-IP bucket tight enough to stop
  one person would silence the room.
- **The database is not close to a constraint.** The join stampede is the peak: ~500 joins
  over a minute, roughly six indexed queries each, ≈ 100 qps against a pool of 20
  connections. Postgres on this box serves that in single-digit milliseconds.

## What was changed in the code

| | where | why |
|---|---|---|
| Explicit 3-rung simulcast ladder | `lib/media.ts` | the ladder *is* the ABR strategy; leaving it to library defaults left it undocumented and free to change |
| Screen share is 1080p and **adaptive** | `lib/media.ts`, `lib/network.ts` | Pinning it to 720p bounded egress by making every share worse for everybody. `SHARE_LADDER` holds 1080p@~5 Mbps / 720p@~3 Mbps floor and cuts fps before resolution — which is what contentHint "text" is for. Single EU SFU vs Zoom PoPs remains a path limit |
| Camera 720p@~2.4 Mbps + grid HIGH≤4 | `lib/network.ts`, `lib/layout.ts` | Stock 1.7 Mbps and MEDIUM-at-3-tiles made featured faces look soft vs Zoom |
| `needKbps(tier, sharing)` counts the share | `lib/network.ts` | Without it a 1080p share on a 3 Mbps link was judged against the camera's need alone, so the ladder saw headroom on a saturated uplink and never stepped down |
| `degradationPreference: maintain-framerate` | `lib/media.ts` | the browser default splits the difference and gets neither; a face at lower resolution still reads as a person talking |
| `AudioPresets.speech` | `lib/media.ts` | 24 kbps mono instead of 48 music. Doubled by RED that is ~48 vs ~96 kbps, multiplied by every publisher for every one of 500 subscribers |
| RED + DTX | `lib/media.ts` | already present; RED reconstructs a lost packet, DTX stops sending silence |
| `networkPriority: high` on audio | `lib/network.ts` | audio and video otherwise compete equally in the browser's own send queue, so the thing nobody can do without loses packets to the thing they can |
| getStats sampling + publish ladder | `lib/network.ts` | steps down on 2 % loss or 300 ms RTT after 2 samples; steps up after 6 clear ones |
| ~~`use_ice_lite: true`~~ → **`false`** | `livekit.yaml` | REVERSED. The theory was that it removes a per-participant connectivity-check loop and shortens the join. Measured, it did the opposite: ICE-lite is a *passive* agent, so it never initiates checks, the UDP pair never completed, and media fell back to TCP 7881 — where an idle transport gets reaped and the ICE restart cost ~20 s. Setting it false took host-late first frame from 24–27 s to ~3.1 s. |
| `packet_buffer_size: 500` | `livekit.yaml` | a webinar audience is on domestic wifi; absorbing reordering costs latency nobody in a one-way broadcast can perceive |
| `limit.bytes_per_sec` | `livekit.yaml` | refuse the participant who would tip the node over, rather than degrading for everyone already connected |

### Why the step-up is slow and the step-down is fast

Asymmetric on purpose. Stepping down late *is* the lag the brief is about. Stepping up
eagerly is worse than it sounds: the step up is itself a bandwidth increase, so it
recreates the congestion that caused the step down, and the audience watches the
resolution pump every twelve seconds. Two samples down, six samples up.

The thresholds are also asymmetric — down at 2 % loss / 300 ms, up below 0.5 % / 180 ms —
because a single band has the state flapping around one number.

### Why simulcast rather than SVC

VP9 or AV1 SVC would give better quality per bit and finer-grained forwarding. The cost
lands on the **subscriber**, and in an audience of 500 there are always low-end Android
phones and locked-down laptops that software-decode VP9 at a crawl or not at all. VP8
simulcast spends some extra upstream on the one publisher to guarantee the 500 can watch.
For a webinar that is the right way round; for a 6-person meeting it would not be.

## Verifying under load

`e2e/probe-room.mjs` drives a real headless Chrome and reports the selected candidate
pair, ICE state and periodic `getStats()` samples — it is what proved UDP media was
working on this host (`udp srflx -> 3.82.201.244:54811 host [succeeded] SELECTED`).

For a load test the honest measurement is egress at the instance, not the browser:

```sh
# On the SFU host, during a session.
docker compose exec livekit sh -c 'cat /proc/net/dev' # or: ifstat -i ens5 1
# And the credit balance, which is what actually runs out:
aws cloudwatch get-metric-statistics --namespace AWS/EC2 \
  --metric-name NetworkBandwidthOutAllowanceExceeded \
  --dimensions Name=InstanceId,Value=i-03bf2bc82b85e62b7 \
  --start-time "$(date -u -v-1H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 60 --statistics Sum
```

A non-zero `NetworkBandwidthOutAllowanceExceeded` is the throttle. That metric going
positive is the moment the session degrades for everyone, and it is the number to watch
before concluding anything about the application.
