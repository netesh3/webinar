# Edge delivery (beta)

A third way to run a webinar, beside **Standard** (everyone on the LiveKit SFU) and **CDN
broadcast** (audience watches the WHEP mix from the SFU box). Edge is opt-in per webinar, so
both can run side by side on the same deployment and be compared.

```
 Stage (1–5 people)                       Audience (hundreds to thousands)
 host, co-hosts, promoted ──WebRTC──▶ SFU ──▶ Egress (room composite, 1s GOP)
                                                │ RTMP
                                                ▼
                                    MediaMTX on the SFU box: LL-HLS
                                    (1s segments, 200ms parts, blocking reload)
                                                │  /live/<slug>/index.m3u8
                                                ▼
                                    Phase 2: Bunny pull zone (CDN) ──▶ hls.js player
 Chat, Q&A, polls, raised hands, controls, stage invites:
   API ──SendData/SetMetadata──▶ LiveKit (stage)       ┐ same packets,
   API ──NOTIFY──▶ every instance ──SSE──▶ edge viewers ┘ same recipient lists
```

## What changes for whom

| | Standard | Edge |
|---|---|---|
| Host, panelists, promoted attendees | WebRTC stage | WebRTC stage (unchanged) |
| Audience picture | SFU (or WHEP mix for CDN-broadcast hosts) | LL-HLS from the origin or a CDN |
| Audience chat/polls/controls | LiveKit data channel and room metadata | `GET /api/webinars/{slug}/events` (SSE) |
| Audience on the SFU | Yes (full or data-only peers) | **No.** Not a participant, not counted against the room size |
| Attendee limit | Live SFU participant count | Open event streams (attendance visits) |

## How it works

- **The switch.** `webinars.delivery` (`standard`|`edge`, migration 0120) behind the
  `edge_delivery` feature (Admin → Accounts → features). Only a single live webinar in this
  app can be edge, not Zoom, simulive or a recurring series. The schedule form shows
  **Delivery: Standard / Edge (beta)** under *Where it runs* only for hosts with the switch.
  Copy webinar carries it.
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
  - A slow client (64 queued events) is dropped and reconnects.
  - There is no replay. On every (re)connect the browser rereads the chat, question and poll
    backlogs, as LiveKit clients do after a reconnect.
- **Browser.** `EdgeAudienceRoom` (`web/components/room/edge-audience-room.tsx`) is the same
  room UI as the CDN attendee room. Its LiveKit `Room` never connects; `lib/edge-events.ts`
  replays the SSE events onto that Room's emitter as `DataReceived`, `RoomMetadataChanged`
  and `Connected`. Every shared hook (chat, Q&A, polls, hands, controls, surveys) runs
  unchanged.
- **Player.** `EdgePlayer` uses hls.js with `lowLatencyMode: true, liveDurationInfinity:
  true, maxBufferLength: 4, maxLiveSyncPlaybackRate: 1.15`.
  - It deliberately does **not** set `liveSyncDurationCount` or `liveMaxLatencyDurationCount`
    in LL mode: hls.js only honours the playlist's `PART-HOLD-BACK` (about 0.6s) when those
    are unset (see 6ffc2e2). The counts (2 and 3) apply only to the non-LL fallback.
  - Safari plays the playlist natively.
  - The player shows how far behind live it is, a **Jump to live** button past 4s, and sends
    an `edge_latency` telemetry sample every 30s when telemetry is on.
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

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `EDGE_PLAYBACK_BASE` | empty | Where viewers play `<base>/<slug>/index.m3u8`. Empty means the origin's own `/live` (per-project `broadcastHlsBase`, else `BROADCAST_HLS_BASE`). Point it at a Bunny pull zone hostname that mirrors the origin's `/live/` path. That is the only switch: no code change. |
| `BROADCAST_RTMP_BASE` | (existing) | Required. The egress pushes the mix here. Without it, edge cannot be chosen. |
| `EDGE_DEBUG_CLOCK` | `false` | Latency aid. Edge webinars' egress loads the composite at `<RECORDINGS_EGRESS_TEMPLATE_URL>/clock`, which draws a server-synced clock (ms) in the corner. The edge player shows its own synced clock beside the latency readout. Glass-to-glass latency is one clock minus the other on a single screenshot. Both sync to `GET /api/time`. |
| `EDGE_ENCODING_WIDTH` / `EDGE_ENCODING_HEIGHT` | `1280` / `720` | Edge mix resolution (even, 320–3840 × 180–2160). |
| `EDGE_ENCODING_FPS` | `30` | 10–60. |
| `EDGE_VIDEO_BITRATE_KBPS` | `1700` | 300–20000. Use about **4500 for 1080p**. |
| `EDGE_H264_PROFILE` | `baseline` | `baseline`, `main` or `high`. Baseline stays the default because the same mix still feeds WHEP for CDN-broadcast hosts, and WHEP cannot take B-frames. Once only HLS consumes the mix, **high** gives noticeably sharper screen-share text for the same bitrate. |

These apply only to edge webinars' egress. The keyframe interval is fixed at 1s, which gives
clean LL-HLS segments and a fast first frame. Values are validated at startup: a bad value
refuses to boot rather than falling back silently. Raise the resolution only where the egress
box can carry it (see Phase 2).

## Test it side by side

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

Expected delay: with the origin alone, about 1.5–3s (PART-HOLD-BACK plus egress encode plus
RTMP). Through a CDN pull zone, add the edge's playlist fetch.

## Phase 2

**Bunny pull zone → MediaMTX LL-HLS origin.** Bunny Stream has no live ingest ("RTMP streams
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
3. Set `EDGE_PLAYBACK_BASE=https://<zone>.b-cdn.net/live` (or a custom hostname) and redeploy
   the API. Nothing else changes.

Optional on the origin, as an infra change: `hlsAlwaysRemux: true` in MediaMTX, so the first
viewer does not wait for the muxer to start.

**Dedicated egress box.** Room composite egress is a headless Chrome plus an x264 encode on
the SFU box: about 2.3 cores at 720p Baseline. That competes with the SFU, which is what
edge delivery is meant to relieve. Move egress (and MediaMTX) to its own machine, then raise
`EDGE_ENCODING_*` to 1920×1080 at ~4500 kbps, profile high if no host on that box uses CDN
broadcast (WHEP).

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
