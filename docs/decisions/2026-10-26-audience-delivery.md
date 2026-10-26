# Audience delivery: plain HLS, by where the viewer is, with capacity limits

**Date:** 2026-10-26. **Status:** in force. **Context:** a customer webinar on 2026-10-25 froze
in waves and the customer moved to Zoom. These decisions followed.

## 1. The audience moved from LL-HLS to plain HLS

**Decision.** Edge viewers play plain HLS (whole fMP4 segments, no parts, no blocking playlist
reloads), from the box or through the CDN. LL-HLS is not used for the audience. (PR #743.)

**Why.** On 2026-10-25 a customer webinar (~130 edge viewers,
`create-your-first-ai-agent-with-ai-automation-6148`) stalled in waves and the customer left.
Bunny's request log showed the cause. Request coalescing merged every viewer's LL-HLS blocking
playlist request into one origin fetch per edge, and that shared fetch stalled. Everyone behind
the edge froze until their player gave up, then jumped forward.

**Evidence.**
- `video1_stream.m3u8?_HLS_msn=1585&_HLS_part=0` at 05:46:43 UTC: 89 viewers at the Singapore
  edge hung until they gave up (`499`), while one viewer at another edge got it at once. The
  next wave (`1592` part 1) was 86 viewers.
- `499`s rose from 3–20 a minute to 1,200–3,300 a minute in the waves; `504`s appeared;
  requests per minute halved as players stalled.
- The origin box was healthy throughout: CPU 14–22%, steady output to Bunny, the mix steady
  into MediaMTX, almost no TCP retransmits. Probes straight to the box never stalled.
- Moving Bunny to the Standard tier (Mumbai and Delhi edges) did not help: the waves continued
  there.
- The 2026-10-24 load test showed the same signature at 1,000 viewers (~227k playlist `400`s,
  Bunny `503`s, 723 of 1,000 test players stalled). It was under-weighted as a test-tool issue.
- Single-client probes never reproduce it: the failure needs many viewers waiting on the same
  request.

**Revisit when** a CDN with proven LL-HLS support (held, coalesced blocking requests delivered
to everyone) passes the browser test in section 6, and hosts ask for lower delay.

## 2. Plain HLS tuned to 1 s segments and a ~3 s player target

**Decision.** MediaMTX writes 1 s segments (10 in the playlist); the player targets 3 s behind
live (~3–4 s glass to glass) for everyone, instead of LL-HLS for India viewers from the box. The
edge mix keeps a 1 s keyframe interval, since segments can only be cut on keyframes.

**Why.** One simple path that works through any CDN. About 2–3 requests a second per viewer
instead of ~10 with LL-HLS, so far less box CPU per direct viewer: in the load test, 500 direct
LL-HLS viewers took a c-4 to ~97% CPU. No second MediaMTX to run and test.

**Trade-off.** A 3 s cushion instead of 6 s: a weak mobile network has less to ride out, so it
stalls a little more readily. CDN viewers can be up to a second further behind (playlists are
cached for a second). To be measured in the browser test.

**Revisit when** the browser test or real webinars show more stalls than with 2 s segments
(then go back to 2 s / 6 s), or hosts need lower delay (see section 1).

## 3. Rejected options

- **LL-HLS for India viewers from a second MediaMTX on the box.** More moving parts, more CPU
  per viewer, and a second path to test, for ~1 s less delay than the tuned plain HLS.
- **LL-HLS through Bunny.** Proven failure (section 1).
- **Cloudflare Stream.** $1 per 1,000 minutes delivered = $0.06 per viewer-hour (~$6 per
  100-viewer hour, roughly 24× Bunny Volume). No latency figure published for normal live; its
  WebRTC option needs WHIP ingest (our mix pushes RTMP) and has no recording.
- **Bunny Standard tier.** Didn't fix it (section 1), at 6× the price in Asia ($0.03/GB against
  $0.005/GB).

## 4. Delivery rule: by where the viewer is

**Decision.** `EDGE_NEAR_COUNTRIES=IN`: viewers in India (or of unknown country) play straight
from the box; everyone else plays through Bunny (Volume tier). Each is given the other as a
fallback, used after repeated network failures.

**Why.** Lowest delay and cost for the India-majority audience (the box is in Bangalore), and a
nearby edge for viewers abroad. Plain HLS caches well, so the CDN is reliable for them.

**Revisit when** a region other than India grows a large audience (give it a box: section 5),
or the box's CPU per direct viewer becomes the limit (move more viewers to the CDN).

## 5. Capacity

**Decision.**
- Max **300 attendees per webinar** (default 50; an admin can override up to 1,000).
  Registrations stop at the limit, by the user's choice. (PR #744.)
- A **pool of video boxes** with capacity points (PR #745): 100 points per c-4. A webinar costs
  20 for its mix, +10 for share or recording, +1 per 10 seats. A meeting costs 4, +1 per 2
  people over 10. A session goes on a box in its region with room; if none has room, the next
  box starts. A region per host.

**Why.** One c-4 carries ~2–3 webinars' mixes and a few hundred direct viewers; past that, a
second webinar must not degrade the first.

**Revisit when** the browser test measures real CPU per session and per viewer: the point
values are estimates to calibrate.

## 6. Process rule: when delivery counts as ready

**Decision.** Delivery is not "ready" until **a real-browser test** (100–150 hls.js players per
path, judged on stalls per viewer per minute) **and real viewers on Indian networks** (Jio,
Airtel, home Wi-Fi) pass. Box CPU and capacity numbers alone don't count.

**Why.** The 2026-10-24 load test measured capacity and was presented as "everything works";
it never proved smooth playback through the CDN, and that cost a customer.

**Revisit:** never relaxed; extend it when a new path or CDN is added.

## Observability that would have caught it

- **Bunny's request log.** Logging is on for the pull zone, kept 3 days, downloadable in the
  dashboard (Monitoring → Logs). Per-minute `499`/`504` counts and requests that many viewers
  waited on show a stuck edge directly.
- **`edge_latency` telemetry stall waves.** The share of viewers reporting a stall per 30 s,
  across a webinar's audience: a few percent is networks; most of the audience at once is
  upstream (the mix, the box or the CDN). Worth an alert.
- **Per-viewer CDN edge in telemetry** (proposed). The player can report which Bunny edge
  served it once Bunny sends `Access-Control-Expose-Headers: Server`, so a wave can be tied to
  one edge without downloading logs.
