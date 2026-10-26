# Edge delivery

The second way to run a webinar, beside **Standard** (everyone on the LiveKit SFU). The old
**CDN broadcast** mode (audience on a WHEP mix) was retired on 2026-10-20. On GCP and
DigitalOcean video servers edge is the **only** webinar delivery (2026-10-23, see "Where edge is
the standard" below). Production video is the on-demand DigitalOcean box and the Hetzner server
is sunset (2026-10-24: no new room goes there, `api/internal/api/sfu_retired.go`), so every new
webinar is edge. Any other server (a dev SFU, LiveKit Cloud) offers every host the Standard /
Edge choice when it has a live origin; the per-account "Edge delivery (beta)" switch
(`edge_delivery`) is gone (migration 0159 removed it from plans and accounts).

```
 Stage (1–5 people)                       Audience (hundreds to thousands)
 host, co-hosts, promoted ──WebRTC──▶ SFU ──▶ Egress (room composite, 1s GOP)
                                                │ RTMP
                                                ▼
                                    MediaMTX on the SFU box: plain HLS
                                    (fMP4, 2s segments, no parts, no blocking reload)
                                                │  /live/<slug>/index.m3u8
                                                ▼
                     direct (near the box) or Bunny pull zone (CDN) ──▶ hls.js player
 Chat, Q&A, polls, raised hands, controls, stage invites:
   API ──SendData/SetMetadata──▶ LiveKit (stage)       ┐ same packets,
   API ──NOTIFY──▶ every instance ──SSE──▶ edge viewers ┘ same recipient lists
```

## What changes for whom

| | Standard | Edge |
|---|---|---|
| Host, panelists, promoted attendees | WebRTC stage | WebRTC stage (unchanged) |
| Audience picture | SFU | Plain HLS (~6s behind) from the box or a CDN, by where the viewer is |
| Audience chat/polls/controls | LiveKit data channel and room metadata | `GET /api/webinars/{slug}/events` (SSE) |
| Audience on the SFU | Yes (full or data-only peers) | **No.** Not a participant, not counted against the room size |
| Attendee limit | Live SFU participant count | Open edge visits: a viewer's browser beats every 30 s (`POST /events/beat`) and says goodbye on leave (`POST /events/leave`); a visit with no beat for 150 s ends at its last beat. The stream connecting or ending is not trusted for attendance. |

## How it works

- **The field.** `webinars.delivery` (`standard`|`edge`, migration 0120). On GCP and DO it
  is always `edge` for a webinar (next section). On any other server with a live origin
  (`BROADCAST_RTMP_BASE`) the schedule form shows **Delivery: Standard / Edge** under *Where it
  runs* for every host. A webinar or a recurring series in this app can be edge; Zoom,
  simulive and meetings cannot. Copy webinar carries it.
- **Recurring series.** Every occurrence is its own webinar row with its own slug, so its own
  mix (started by its Start, stopped by its End), MediaMTX path `live/<slug>`, event stream
  and attendance. A save that writes several occurrences (create, convert to a series, "this
  and following") writes the delivery to each draft or scheduled one it covers
  (`SetSeriesDelivery`); an occurrence that is live or over keeps its own.

## Where edge is the standard (GCP and DigitalOcean)

- **Rule.** A webinar (one-off, instant or recurring) in this app whose room is, or will be,
  on a project whose provider is `gcp` or `do` is saved as edge, whatever the form sent
  (`resolveDelivery`, `api/internal/api/edge.go`). Meetings and simulive are always standard.
  Not forced without `BROADCAST_RTMP_BASE` (no origin to push to), and never changed on a
  webinar that is live or ended.
- **Provider.** The project's `provider` in `LIVEKIT_PROJECTS`, else guessed from its id and
  label (`do-blr` → do, `india`/Mumbai → gcp, anything else Hetzner; `CostProvider`). A
  Hetzner project takes no new rooms while any other project does, so give a new entry its
  `"provider"`.
- **Before the pin.** A webinar is pinned to a project on its first join. Until then the
  target is what that join would choose: the host's assigned project (Admin → Accounts → Video
  server) when it is enabled and not Hetzner, else `SFU_BOX_PROJECT` (the box), else the first
  enabled project (`firstChoice`). No enabled project at all counts as edge. An admin who
  reassigns the host before the first join moves the room; edge works on every provider. A
  webinar not run yet that is still pinned to Hetzner is judged by where it will move.
- **Form.** `GET /api/host/delivery[?slug=]` (`types.DeliveryPolicy`): `edgeOnly` hides the
  choice and shows "Your audience watches a low-latency stream; speakers join live"; the
  instant button sends edge with no choice beside it (`web/lib/delivery-policy.ts`).
- **Existing webinars.** At boot the API moves draft and scheduled webinars (`kind` live or
  recurring, venue app) pinned to, or headed for, a GCP/DO project onto edge
  (`BackfillEdgeDelivery`, idempotent; no SQL migration, because the provider lives in config).
  Live and ended sessions, meetings, simulive and Zoom are untouched. Before it,
  `MoveOffRetiredServers` unassigns hosts from Hetzner and moves draft and scheduled webinars
  pinned there to the box (switching them to edge); one with people in its Hetzner room moves at
  a later join instead.
- **Costs.** The audience is ~2.5 s behind the stage, which shows in Q&A and stage invites.
  Each concurrent webinar runs one composite mix (~1–1.5 cores on the DO c-4, or an egress
  worker on GCP), so plan the box from the number of concurrent webinars, not attendees.
- **Join.** For an edge webinar, an attendee who is not on the stage gets no LiveKit token. The
  join response has `delivery: "edge"`, `playbackUrl` and `eventsToken`, which is signed with
  `SESSION_SECRET` under its own issuer and lasts 6h. Anyone on the stage gets an ordinary
  stage token with `edgeWebinar: true`.
- **Events.** The SFU pool is wrapped (`api/internal/api/edge.go`, `edgePool`). Every
  `SendData` on the `webcast` topic and every `SetMetadata` is also published to
  `internal/realtime`, so no call site needed editing. Recipients follow LiveKit's rule:
  an empty list means everyone, a list means only those identities. Delivery across Cloud Run
  instances goes through Postgres `LISTEN/NOTIFY` on channel `webcast_realtime`.
  - Each instance opens **one dedicated connection** (not from the pool), and only once it
    has its first edge viewer. This needs a session-mode connection: Supabase's session
    pooler on :5432 works, the transaction pooler on :6543 does not.
  - Envelopes over about 7.8 KB become a `refetch` event, and the browser reads the backlog.
- **The stream.** `event: meta` (room metadata), `event: packet` (the same JSON the stage
  receives), `event: refetch`, `event: reconnect`.
  - A heartbeat comment goes out every 15s, and the server ends the stream at 25 min so the
    browser reconnects before Cloud Run's request timeout.
  - The per-write deadline is extended, so the server's 60s `WriteTimeout` does not cut it.
  - Behind the CDN and Cloud Run a closed tab does not end its stream on the server (the
    proxies keep accepting the heartbeats). So the viewer's goodbye (`/events/leave`, or the
    host removing them) publishes a `bye` on the bus that ends their older streams on every
    instance. While live, a stream whose viewer has not beaten for 150 s is ended with
    `reconnect` at its next heartbeat (`api/internal/api/edge_idle.go`). Before this, every
    stream in the 24 Oct 2026 load test ran its full 25 minutes.
  - A slow client (64 queued events) is dropped and reconnects.
  - There is no replay. On every (re)connect the browser rereads the chat, question and poll
    backlogs, as LiveKit clients do after a reconnect.
- **Browser.** `EdgeAudienceRoom` (`web/components/room/edge-audience-room.tsx`) is the same
  room UI as the CDN attendee room. Its LiveKit `Room` never connects; `lib/edge-events.ts`
  replays the SSE events onto that Room's emitter as `DataReceived`, `RoomMetadataChanged`
  and `Connected`. Every shared hook (chat, Q&A, polls, hands, controls, surveys) runs
  unchanged.
- **Why plain HLS, not LL-HLS (2026-10-25).** The audience played LL-HLS (1s segments,
  250–500ms parts, blocking playlist reloads, ~2s behind) until a customer webinar froze in
  waves through Bunny. Bunny's request log showed why: request coalescing ties every viewer
  waiting for the next part to one origin request, and those shared requests got stuck. For
  `video1_stream.m3u8?_HLS_msn=1585&_HLS_part=0`, 89 viewers at the Singapore edge waited until
  they gave up (`499`), 1–6s, while the origin was healthy and answered the same request for
  another edge at once; the next wave (`1592` part 1) was 86 viewers, and moving the zone to
  Bunny's Standard tier (Mumbai, Delhi edges) did not change it. ~130 viewers made 60–80k
  requests a minute. The HLS spec asks CDNs to hold duplicate blocking requests and deliver
  them from the pending fill (RFC 8216bis, Appendix B); in practice the shared fill is a single
  point of failure for everyone behind an edge. Plain HLS is about one request a second per
  viewer, every one cacheable, and nothing is held open. The cost is delay: ~6s behind live
  (5–8s glass to glass) instead of ~2s, which a webinar does not feel — the stage talks over
  WebRTC, and chat, polls and Q&A have their own channel.
- **Which path a viewer gets.** With `EDGE_NEAR_COUNTRIES` set (e.g. `IN`), a viewer in one of
  those countries, or of unknown country, plays the box directly (the project's
  `broadcastHlsBase`), and everyone else plays the CDN (`edgePlaybackBase`, else
  `EDGE_PLAYBACK_BASE`), which serves them from an edge near them. The country is Cloudflare's:
  the site's Worker sends it as `X-Viewer-Country` (it drops the client's own CF-* headers).
  The join returns `deliveryPath` (`direct`|`cdn`) and the other path as `fallbackPlaybackUrl`
  (`config.EdgePlaybackChoiceFor`). Unset, everyone plays `edgePlaybackBase` as before.
- **Player.** `EdgePlayer` uses hls.js with one setting for everyone (`lib/edge-hls.ts`):
  `lowLatencyMode` off, `liveSyncDuration` 6s (`TARGET_SECONDS`), a 12s buffer, playback
  speed never changed (`maxLiveSyncPlaybackRate: 1`: time-stretched audio warbled, 2026-10-20).
  - **Keeping near live.** Each stall adds to hls.js's distance from live and nothing wins it
    back, so once the player is more than 6s past its target it skips forward, landing no
    further than 1s short of what is buffered so the skip never waits on a black frame
    (`catchUp` / `seekToTarget`). Skips are at least 15s apart (`JUMP_COOLDOWN_MS`).
  - A stall or a recovery never shows black: the last frame is held on a canvas, and a
    "Reconnecting…" badge appears if it stays stuck for 4s. Fatal network errors retry with
    backoff (1, 2, 4, 8, 10s); after 4 in a row with no playback the player moves, once, to
    `fallbackPlaybackUrl` (`shouldUseFallback`), and reports `edge_fallback`. Media errors use
    hls.js's recovery.
  - Safari plays the playlist natively.
  - **Back to live** appears past 20s behind (`BEHIND_LIVE_SECONDS`). `edge_latency`
    telemetry every 30s carries the latency, the delivery path (`delivery`: `direct`|`cdn`),
    the stall count and the median time to first byte.
- **Layout.** Edge webinars' egress loads the composite at `<template>/edge`. While someone
  shares their screen the share fills the **whole frame** and up to three camera tiles sit
  small over the bottom-right corner (`lib/composite-layouts.ts`), for cameras that are on only:
  someone with their camera off gets no initials tile over the slides. Next to the standard 22%
  camera strip a share got only ~1000×560 of a 1280×720 frame, which made slide text
  unreadable. Recordings and the CDN broadcast keep the standard layout. That is the `auto`
  **audience layout**; the host can pick another in Host controls (speaker, grid, share only,
  share + speaker bubble, side by side, cameras only). It is a session control
  (`audienceLayout`, PATCH `/controls`) mirrored into room metadata, so the egress page, which
  is in the room, re-lays the composite live without restarting the egress. Tiles are the
  stage only (camera/share publishers or camera-permitted participants; never the egress or
  an agent), thumbnails under 300px ask for the low simulcast layer, and the grid stops at
  one page (16).
- **A bad destination no longer takes the mix down.** The compositor starts on our origin
  alone and each platform (YouTube or pasted key, LinkedIn, Instagram, Facebook) is attached
  with its own `UpdateStream`. A platform that refuses its key is retired for the session
  (`mix_destinations.go`): detached, not retried on restarts, and shown to the host in the
  platform's dialog ("refused this stream key"). Pausing and resuming, or saving a new key,
  tries it again. Before this, one stale key failed the whole egress every 30s and viewers
  saw black (2026-10-18).
- **The mix survives a host refresh.** Edge rooms are created with a 3-minute departure
  timeout instead of the server's 20s: the audience is not in the room, so a host dropping for
  half a minute used to empty it, close it, and end the compositor ("Source closed"). And a mix
  that ends while live is put back from the egress webhook within ~3s, not at the next
  sweeper pass; restarts that keep failing back off (10s doubling to 5 min).
- **Stage.**
  1. Raise hand goes through `/say` as before.
  2. The host's invite reaches the viewer over SSE.
  3. Accepting stores the stage grant. The viewer is not in the room, so `SetRole` answers
     `not in room` and is skipped.
  4. The browser joins again, gets a stage token, and swaps the player for the WebRTC room.
  5. On demotion the WebRTC room notices, joins again, and goes back to the feed.
  6. Removing a viewer records the removal, sends them a `removed` packet, and refuses their
     stream from then on.
- **Host.** The room header shows **Edge · N watching**, which is open streams, from
  `GET /api/host/webinars/{slug}/edge`. The participant list still shows only the stage,
  because viewers are not in the video room.

## Per-box settings (`/opt/livekit/.env` on the SFU box, applied by `redeploy.sh`)

| Variable | Default | Meaning |
|---|---|---|
| `HLS_PART_DURATION` | — | No longer used (LL-HLS parts). Ignored if still in an old box's `.env`. |
| `EGRESS_REMOTE` / `EGRESS_VPC_CIDR` | unset | Remote-egress mode: composites run on egress worker VMs (`deploy/egress-worker`), not on the box. |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `EDGE_PLAYBACK_BASE` | empty | Where viewers play `<base>/<slug>/index.m3u8`. Empty means the origin's own `/live` (per-project `broadcastHlsBase`, else `BROADCAST_HLS_BASE`). Point it at a Bunny pull zone hostname that mirrors the origin's `/live/` path. That is the only switch: no code change. |
| `BROADCAST_RTMP_BASE` | (existing) | Required. The egress pushes the mix here. Without it, edge cannot be chosen. |
| `EDGE_NEAR_COUNTRIES` | empty | ISO country codes (`IN`, or `IN,LK`) whose viewers play the box directly; everyone else plays the CDN, each with the other as a fallback (see "Which path a viewer gets"). Empty: everyone plays the CDN base as before. (`EDGE_PLAYBACK_LOW_LATENCY` is gone with LL-HLS; it is ignored if still set.) |
| `EDGE_DEBUG_CLOCK` | `false` | Latency aid. Edge webinars' egress loads the composite at `<RECORDINGS_EGRESS_TEMPLATE_URL>/edge/clock`, which draws a server-synced clock (ms) in the corner. The edge player shows its own synced clock beside the latency readout. Glass-to-glass latency is one clock minus the other on a single screenshot. Both sync to `GET /api/time`. |
| `EDGE_ENCODING_WIDTH` / `EDGE_ENCODING_HEIGHT` | `1280` / `720` | Edge mix resolution (even, 320–3840 × 180–2160). |
| `EDGE_ENCODING_FPS` | `25` | 10–60. The keyframe interval stays 1 s (25 frames at 25 fps). |
| `EDGE_VIDEO_BITRATE_KBPS` | `1500` | 300–20000 (1500 is the old 1700 at 30 fps scaled to 25). Use about **4500 for 1080p**. |
| `EDGE_AUDIO_BITRATE_KBPS` | `128` | AAC bitrate of the mix, 32–320. `96` is plenty for speech and trims ~30 kbps a viewer. |
| `EDGE_H264_PROFILE` | `baseline` | `baseline`, `main` or `high`. Baseline was the default while the mix also fed WHEP, which cannot take B-frames. With WHEP retired, **high** gives noticeably sharper screen-share text for the same bitrate. |

**Recommended test encoding for screen-share legibility:** `EDGE_ENCODING_WIDTH=1920`,
`EDGE_ENCODING_HEIGHT=1080`, `EDGE_ENCODING_FPS=20`, `EDGE_VIDEO_BITRATE_KBPS=3500`,
`EDGE_H264_PROFILE=high` — once only HLS consumes the mix (no CDN-broadcast hosts). 20 fps
keeps the encode close to today's 720p30 in CPU, and for slides resolution matters far more
than frame rate. Until the dedicated egress box exists this runs on the **shared SFU box**,
so watch its CPU in Grafana during the test, and go back to the defaults if the stage starts
to suffer. Raise the bitrate only after the CDN pull zone is in place: the current path to the
origin struggles even at 1.7 Mbps.

**How big a share is in the mix.** The mix is drawn at the encoding's size, so a presenter's
1080p share is scaled down to whatever box the layout gives it, and no bitrate gets that
back. At 1280×720: share only and share + speaker draw it at 1280×720 (0.67 of 1080p);
speaker view, the edge default while somebody shares, at 960×540 (0.5, so 14 px code lands at
7 px); the old auto layout drew it at about 990×557. The recorder template always takes the
share's 1080p layer (`ShareVideo`, no adaptiveStream), so this scaling happens once.

The encoding is fixed for an egress's lifetime: LiveKit cannot change it on a running job,
and restarting the mix at each share start and stop would cut every edge viewer (and the mix
recording) twice per share. So the share profile is chosen per deployment, with these costs
per attendee-hour at the calculator's $0.005/GB (`edgeGbPerViewerHour`, 6% HLS overhead,
96 kbps audio):

| `EDGE_ENCODING_*` | speaker-view share | GB / attendee-hour | $ / attendee-hour |
|---|---|---|---|
| 1280×720, 1000 kbps (production today) | 960×540 | 0.52 | 0.0026 |
| 1920×1080 @ 15 fps, 1300 kbps, high | 1440×810 | 0.67 | 0.0033 (+27%) |
| 1920×1080 @ 15 fps, 1600 kbps, high | 1440×810 | 0.81 | 0.0040 (+55%) |

1080p at 15 fps is about 1.7× the pixel rate of 720p at 20 fps: the composite measured
0.7 cores average and 1.7 peak at 720p20 on the DO box (EG_8myRDkubzvv4, 2026-10-22), so
expect ~1.2 / ~2.9 there. Only move to it where the egress is not sharing four cores with
the SFU. Lowering `EDGE_ENCODING_FPS` from 20 to 15 at the same resolution and bitrate gives
each frame a third more bits for the price of nothing, and slides do not need 20 fps.

These apply only to edge webinars' egress. The keyframe interval is fixed at 1s, which gives
clean LL-HLS segments and a fast first frame. Values are validated at startup: a bad value
refuses to boot rather than falling back silently. Raise the resolution only where the egress
box can carry it (see Phase 2).

### A lighter mix for cameras

The egress decodes every video track the SFU forwards to it, in software, in the Chrome that
also composites and encodes the mix. Cameras publish 180p / 360p / 1080p (720p on top on
machines that cannot capture 1080p), and the template used to take the top layer for every
camera tile 300 px or taller, and for every camera on stage whether the layout drew it or not
(speaker view's other cameras, the strip past its last tile). So a 720p mix of four cameras
and a share was up to four 1080p VP8 decodes for one 360p-sized picture.

The recorder template now picks each camera's layer from the box the layout gives it
(`web/lib/mix-subscriptions.ts`, used by `useCameraSubscriptions` in
`web/app/recorder-template/[[...slug]]/page.tsx`):

| Tile height (output px) | Layer |
|---|---|
| over 540 | top (720p or 1080p, as published) |
| 300–540 | medium (360p) |
| under 300 | low (180p) |
| speaker view's bare tile | medium |
| not drawn | not forwarded (`setEnabled(false)` after a 3 s grace) |

The rects are the layout's own, in CSS px of the egress window (the encoding's size at pixel
ratio 1), so headless Chrome's `devicePixelRatio` plays no part. `adaptiveStream` stays off:
livekit-client ignores `setVideoQuality` / `setEnabled` while it is on. **Screen shares are
untouched**: always the top layer, whatever their box.

What it does at 1280×720, by layout: a 2–4 camera grid (344–351 px tiles) goes from top to
medium; auto with someone sharing (speaker view on edge) decodes one medium camera instead of
one medium plus every other camera at the top layer; auto without a share is unchanged (main
speaker on top, strip low) apart from cameras past the strip, which are no longer forwarded.

**Expected saving.** Measured before on the c-4 box: ~0.7–1.0 core for 1–2 cameras, ~1.84 for
3–4 cameras and a share. The decode part of that should fall the most where cameras were
hidden or in a grid; 25 fps instead of 30 removes a sixth of the composite and x264 work
wherever the deployment uses the default. Together, expect roughly 30–40% less egress CPU in
the 3–4 cameras + share case and less in the single-camera case (one camera filling the frame
still needs the top layer). This is an estimate, not a measurement.

**How to verify.** In Grafana, during the same scenario before and after the deploy:

```
sum(rate(container_cpu_usage_seconds_total{service="egress"}[1m]))
```

(cores used by the egress container; the egress also logs `avgCPU`/`maxCPU` in its `egress
metrics` line). Compare like with like: same layout, same number of cameras, a share on or
off, a few minutes each.

**The frame rate default only applies where `EDGE_ENCODING_FPS` is unset.** A deployment that
sets it (the GitHub repository variable feeds Cloud Run, `deploy/cloudrun-deploy.sh`) keeps its
own value; one already below 25 should stay there, since 25 would cost more, not less.

**Trade-offs.** The audience stream (and the mix recording, which copies it) shows camera
tiles at 360p in a 2–4 camera grid and never above the publisher's top layer; one large camera
tile still gets it. A 25 fps mix moves slightly less smoothly than 30 (fast hand motion);
for talking heads and slides it is not visible. A camera that the layout starts drawing again
after its 3 s grace waits for a keyframe (a few hundred ms of the avatar tile). Cloud
recordings that use this template at 1080p get the same mapping: a 2x2 grid's 540 px tiles
take the medium layer there too.

**LL-HLS and captions.** MediaMTX splits parts on frame boundaries: a 250 ms part at 25 fps is
about six frames, at 500 ms about twelve, and segments (1 s) still each start on the 1 s
keyframe. The mix recorder (mixrec) copies the stream, so recordings become 25 fps with no
other change. Caption sync uses the player's measured delay, not the frame rate.

## Test it side by side

On a Hetzner project (on GCP/DO there is no Standard webinar to compare against):

1. Deploy. The migration runs on its own.
2. **Admin → Accounts →** pick a host **→ Features → Edge delivery (beta)** on.
3. As that host, schedule two webinars: one **Standard** and one **Edge (beta)** (*Where it
   runs → Delivery*).
4. Start both. Open each attendee link in a few browsers or phones, including one on mobile
   data.
5. Check:
   - **Edge viewer:** the network tab shows `index.m3u8` and parts (no LiveKit websocket),
     plus one `events` request (EventSource).
   - **Chat, Q&A, polls, reactions, raised hands** work both ways.
   - **Host header:** shows *Edge · N watching*.
   - **Raise hand, then host invites, then Accept:** the viewer moves to the WebRTC stage.
     **Move to audience** puts them back on the stream.
   - **Latency:** read the viewer's "behind" readout. For an exact number set
     `EDGE_DEBUG_CLOCK=true`, screenshot a viewer, and subtract the composite clock (in the
     video) from the player clock (in the overlay).
6. Compare SFU load in Grafana (CPU, packets/s) with N viewers on the edge webinar against
   the same N on the standard one.

Expected delay: about 6s behind the origin's live edge, 5–8s glass to glass, the same on both
paths.

## Phase 2

**Bunny pull zone → MediaMTX HLS origin.** (Written for LL-HLS; since 2026-10-25 the origin is
plain HLS, so the `_HLS_msn` / `_HLS_part` notes below no longer apply. What a pull zone needs
now: origin `Cache-Control` respected (Caddy sends 1s for playlists, 300s for segments), error
responses not cached, request coalescing on for segments. While any viewer may still be on an
LL-HLS player, add an Edge Rule **Disable Request Coalescing** for `*.m3u8` under `/live/`.) Bunny Stream has no live ingest ("RTMP streams
are currently not supported"), so instead of pushing a second RTMP copy, a Bunny pull zone
mirrors the existing origin, and viewers fetch from the edge.

1. Create a pull zone with the origin `https://live.webinarliv.com`, which proxies `/live/*`
   to MediaMTX :8888. Set **Origin Shield** on, near the origin (Frankfurt).
2. Caching rules (Edge Rules):
   - **Playlists (`*.m3u8`):** no caching or a very short TTL (≤1s), and **pass query strings
     through to the origin**, including `_HLS_msn` and `_HLS_part`. These are the LL-HLS
     blocking-reload parameters. If the CDN drops them or serves a cached playlist, the
     player falls back to polling and latency jumps.
   - **Segments and parts (`*.m4s`, `*.mp4`):** cache long (immutable names; minutes to an
     hour is fine). Query strings are not needed.
   - Respect the origin's `Cache-Control` (Caddy already sends `max-age=1` for playlists).
   - Nothing to set for MediaMTX's viewer sessions: Caddy sends MediaMTX's `hlsCDNSecret` on
     every `/live/*` request, so all viewers share one session and the same URLs. Without it
     each viewer got a `cookieCheck` redirect and a `session=<token>` on every playlist and
     part URL, so the pull zone cached nothing across viewers and every LL-HLS request went
     to the origin (~0.7s each from India: 6–8s behind on a Bunny-fronted test, 2026-10-19).
3. Set `EDGE_PLAYBACK_BASE=https://<zone>.b-cdn.net/live` (or a custom hostname) and redeploy
   the API. Nothing else changes.

Optional on the origin, as an infra change: `hlsAlwaysRemux: true` in MediaMTX, so the first
viewer does not wait for the muxer to start.

**Dedicated egress box.** Room composite egress is a headless Chrome plus an x264 encode on
the SFU box: about 2.3 cores at 720p Baseline. That competes with the SFU, which is what
edge delivery is meant to relieve. Move egress (and MediaMTX) to its own machine, then raise
`EDGE_ENCODING_*` to 1920×1080 at ~4500 kbps, profile high.

**480p rendition for weak connections (not built).** ffmpeg on the egress box reads the mix
from MediaMTX (`live/<slug>`), transcodes it to 854×480 at about 800 kbps, and publishes a
second path (`live/<slug>_480`). A small master playlist lists both variants, so hls.js can
step down on a poor connection. Point `EDGE_PLAYBACK_BASE` at the master playlist path.

**Sizing:** about **5 cores per concurrent 1080p webinar with the 480p rendition** (compositor
plus 1080p encode plus 480p transcode). Plan the box from the expected number of concurrent
edge webinars.

## Limits in this phase

- Edge viewers are not in the host's participant list, which comes from LiveKit. They show in
  attendance, in the viewer count, and as senders in chat, Q&A and raised hands (which carry
  their identity, so promotion and removal work from there).
- Stage invites are still held in one API process's memory (pre-existing). With several
  instances, an invite and its answer must reach the same instance within 60s.
- One event stream per identity is assumed. A second tab works, but closing either one ends
  the attendance visit.
- The composite egress for an edge webinar uses the edge encoding. A recording started
  during it still uses the existing combined-egress path and encoding.
