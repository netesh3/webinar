# Load testing

The kit in `e2e/load/` answers one question for a live session on the DigitalOcean video box: how many edge (LL-HLS) viewers does it carry before people notice? It also covers the other pieces of the same session: presenters on stage, chat/Q&A/polls, and WebRTC tabs for meetings.

It runs from a generator droplet in BLR1 (or a laptop, at small scale). It goes through the public API the same way the browser does, and it cleans up after itself.

## The tools

| Tool | What it is | What it measures |
|---|---|---|
| `run.mjs` | One command for the whole test: test host and edge webinar → seats → go live → wait for the video box → presenters → (cloud recording) → ramp viewers here and on other generators (+ API load, + engagement check, + WebRTC tabs) → summary → end → delete | Everything below, plus the server's own viewer count (`GET /host/webinars/{slug}/edge`) every 30 s, PASS/FAIL checks, and optional Grafana numbers per step |
| `hls-viewers.mjs` | N simulated edge viewers, in steps, over several processes | See the next table |
| `presenter.mjs` | Headless Chrome on the stage at `/host/<slug>/room`, publishing a looping 720p30 test video (ffmpeg `testsrc2`) and a 440 Hz tone; optional screen share | Outbound resolution, fps, kbit/s, and `qualityLimitationReason` (cpu/bandwidth) |
| `api-load.mjs` | What an audience does besides watching, at rates you set: chat, questions, upvotes, poll votes, joins, public registrations, extra event streams | Latency p50/p95/p99 and errors per action, in 30 s windows |
| `engage.mjs` | The engagement check (`run.mjs --engage`, or on its own against a run in progress): a tagged chat burst, questions and upvotes, polls and quizzes opened, voted and closed one at a time | Whether the server stored exactly what it accepted: a PASS/FAIL table |
| `webrtc-attendees.mjs` | Flags around the existing `e2e/probe-load.mjs`: N Chrome tabs, steps, meeting or webinar | Per-tab inbound bitrate, fps, freezes, loss, resolution |
| `setup-generator.sh` | cloud-init for a fresh Ubuntu 24.04 droplet: Node 22, Chrome, ffmpeg, the kit, file and port limits, TCP tuning | (none) |

### What one HLS viewer does

Each simulated viewer follows the browser's path (`web/lib/edge-*.ts`, `components/room/edge-player.tsx`) as far as the server can tell the difference:

1. **Join.** `POST /api/webinars/{slug}/join {joinKey}` returns `playbackUrl`, `eventsToken` and `lowLatency`.
2. **Event stream.** It holds `GET /api/webinars/{slug}/events?t=<token>` open.
   - On connect it loads the backlogs: `/chat?since=0`, `/questions`, `/polls`.
   - On a `reconnect` event it reconnects after 0.5–2 s.
   - On a 401 it joins again with `?rejoin=1`.
   - On other failures it backs off from 2 s to 60 s.
3. **Beats.** It sends `POST /events/beat` every 30 s. Attendance closes a visit after 150 s without a beat, so these beats are what make the viewer count.
4. **The stream, the way hls.js `lowLatencyMode` plays it.**
   - It loads the multivariant playlist, picks the first variant, and plays that variant's audio rendition too if it is separate.
   - It fetches the init segment once and starts `PART-HOLD-BACK` behind live.
   - It fetches every part once, in order (whole segments when not in low-latency mode).
   - It reloads the playlist alongside the part fetches, not after them, as hls.js does. While the playlist advances it uses `_HLS_msn` / `_HLS_part` blocking requests (each times out after max(3 part targets, 0.8 target durations)). When the playlist did not advance, or the server cannot block, it polls: every target duration, or half of one when nothing changed.
   - It never repeats a failed blocking reload's `_HLS_msn` / `_HLS_part`. After a timeout it reloads the plain playlist at once. After any other failure it waits 1 s, 2 s, 4 s, then 8 s at most before the plain reload. It honours the CDN's `Age` header the way hls.js's "CDN tune-in" does. If it falls behind the playlist window, it starts again at the live edge.
   - Before the mix is up, it retries the playlist every second.
   - Runs before 2026-10-24 (run 6) retried a failed blocking reload with the same URL every second. MediaMTX returns 400 at once for an `_HLS_msn` older than its window, so one CDN 503 or timeout took a viewer off the stream for the rest of the step. That is the `playlist 400` flood and most of the stalls in run 6. Real hls.js does not do this.
5. **Leave.** `POST /events/leave` at the end, like the page's `pagehide` beacon.

The bytes are read and dropped. A playback model turns arrival times into two numbers:

- **Stalls:** the buffer ran dry for at least 100 ms.
- **Live latency:** the wall clock minus the `EXT-X-PROGRAM-DATE-TIME` at the playhead. Both machines need NTP; DigitalOcean droplets have it.

The player mode comes from what join says (`EDGE_PLAYBACK_LOW_LATENCY`), unless you pass `--low-latency` or `--no-low-latency`. The browser can also move up to LL by itself when its TTFB is low. The kit does not do that, so force the mode you want to measure.

Per step, the summary table and the JSON report:

| Column | Meaning |
|---|---|
| `active`, `joinOk`, `joinFail`, `join95` | Viewers running; joins in this step; join latency p95 (ms) |
| `media50/95/99` | Part (or segment) fetch latency (ms). In low-latency mode, p95 should stay well under the part duration (500 ms) |
| `pl95` | Playlist fetch p95 (ms). Blocking reloads (`playlistBlocking` in the JSON) include the server's hold, so they are not a latency |
| `stalls`, `stalledNow` | Stalls in the step, and viewers stalled at the moment the step closed |
| `live50s`, `live95s` | Live latency (s) |
| `sseOpen`, `beatFail` | Event streams open at step end; failed beats |
| `Mbit/s` | What the generator pulled |
| `cpu%`, `loop99` | The generator's own health (see "Honest limits") |
| `errors` | `<what> <status>` × count, e.g. `part 404x3`, `join 429x10`, `events timeout` |

The server's own count (`server counts N edge viewer(s)`) is printed every 30 s and stored in `results.json`. It should track `active`. If it lags, beats or event streams are being lost.

## What the server needs (admin-only, off by default)

A real viewer gets a join key by registering and then verifying their email. A real webinar admits at most its plan's attendee ceiling (500 at most). A script can do neither, so the API has three admin endpoints (`api/internal/api/admin_loadtest.go`):

| Endpoint | Does |
|---|---|
| `POST /api/admin/users/{id}/verify-email` | Marks a test account's address verified so it can sign in |
| `PUT /api/admin/webinars/{slug}/load-test {viewers}` | Marks the webinar as a load test admitting `viewers` (1–5000) instead of the plan ceiling. `DELETE` turns it off |
| `POST /api/admin/webinars/{slug}/load-test/seats {count}` | Mints up to 1000 name-only viewer seats per call (never more in total than `viewers`) and returns their join keys |

**The guard is the test-account rule.** These endpoints accept only an account, or a webinar host, whose email ends in `.invalid`. That is the reserved TLD that cannot receive mail. A customer can never sign in from such an address, because the verification mail never arrives. So a load test cannot be switched on for a customer's webinar, and its seats cannot be put into one. The kit's host is `host-<run>@loadtest.invalid`.

Everything is logged as an `admin action`. The public registration path has no bypass, and the rate limits are unchanged.

### What the kit needs from you

An admin account. Set `PROBE_ADMIN_EMAIL` and `PROBE_ADMIN_PASSWORD` to an account listed in the API's `ADMIN_EMAILS`. With it, the kit makes and later deletes:

- the test host: signup, then verify-email, `canHost`, and `instant_webinar` granted (the `e2e/grant-host.mjs` pattern);
- for `--presenters 2..3`, panelist accounts;
- the webinar, marked as a load test;
- the seats.

`--sfu-project <id>` pins the host to a video server. By default the host lands where any new host does.

### Keeping it out of analytics, the CRM and mail

- **Seats** are guest registrations: a name (`Load viewer N`), no email, no account. Nothing mails them. The CRM hook (`engage.OnRegistered`) and the confirmation and reminder mails are never called. No `users` row is created.
- **The host, panelists and api-load registrants** use `.invalid` addresses. The API never mails `.invalid` (verify, welcome, reset, recap, retention all skip it). api-load registrations stay unverified, so no confirmation mail, CRM contact or WhatsApp invite follows. They do create unverified audience accounts. `run.mjs` deletes those at cleanup: it finds them by the run id in their address.
- **The webinar** has email and WhatsApp reminders off, AI off (no spam-check or auto-answer spend), and no recording unless you pass `--record` (then the test host is granted `cloud_recording`, and the recording is deleted with the webinar).
- **Browsers:** presenters and WebRTC tabs map Google Analytics and GTM to 0.0.0.0 (`--host-resolver-rules` in `lib/chrome.mjs`), so the hardcoded GA4/GTM tags never fire.
- **Deleting the webinar** removes its seats, visits (attendance), chat, questions, polls and the load-test mark. While the test runs, admin stats and the Grafana and Cloud Run graphs do show it. That is the point.

### Rate limits the generator meets

| Limit | Default | Effect |
|---|---|---|
| `JOIN_RATE_PER_MIN` (per client IP, per API instance) | 1200/min | Viewers join from one IP. A ramp of 500 in 30 s is 1000/min, which is fine. Do not ramp faster than about 600 per 30 s per generator. 429s show as `join 429` |
| `REGISTER_RATE_PER_MIN` (per IP) | 30/min | Only api-load's `--register` uses it. Above 0.5/s you will see 429s; that is the limit working |
| `say` / vote per sender | 90/min | api-load keeps each seat under 60/min |
| Events, beats, leave | none | (none) |

There is no captcha or bot check, and no allowlist was added. The client IP is the left-most `X-Forwarded-For`, otherwise the peer. Through `webinarliv.com`, the Cloudflare Worker strips the forwarding headers, so the API may see the Worker's egress addresses rather than the generator. That is unconfirmed; compare a run with `--api https://<service>.run.app/api` if joins 429 early.

## Running it

### 1. The generator droplet (the lead runs this, with approval: it creates a billed resource)

```bash
# BLR1, next to the video box. c-8 for HLS viewers; c-16 if you also run 50-100 WebRTC tabs.
doctl compute droplet create loadgen-blr1 --region blr1 --size c-8 --image ubuntu-24-04-x64 \
  --ssh-keys <your key id> --tag-names loadgen --user-data-file e2e/load/setup-generator.sh --wait
ssh root@<ip> 'tail -f /var/log/loadgen-setup.log'      # until "ready"
```

- `setup-generator.sh` fetches the kit from `main` (`LOADGEN_REF` picks another ref).
- Delete the droplet when done: `doctl compute droplet delete loadgen-blr1 --force`.
- Approximate DigitalOcean prices (check the pricing page):
  - c-8 (8 vCPU / 16 GB): about $0.25/h.
  - c-16: about $0.50/h.
  - An afternoon of testing costs a few dollars.
  - Inbound transfer is free.
- The test also costs:
  - **CDN egress:** 1000 viewers × ~1.8 Mbit/s (1700 kbit/s video + audio) × 10 min ≈ 135 GB through the pull zone, about $1–4 at Bunny's Asia rates.
  - **Video-box egress:** small through the CDN. Bunny's request coalescing collapses the viewers' requests into about one copy of the stream (1.2 Mbit/s of MediaMTX HLS out at 1,010 viewers on 24 Oct). The origin shield is off: Bunny offers shield locations only in Paris and the US. With `--origin`, all of it comes from the box's transfer pool instead.
  - The box itself, which is up for the session as usual.

### 2. A dry run, then the step plan

```bash
ssh root@<ip>
cd /opt/loadgen/e2e/load && ulimit -n 1048576
read -r PROBE_ADMIN_EMAIL; read -rs PROBE_ADMIN_PASSWORD; export PROBE_ADMIN_EMAIL PROBE_ADMIN_PASSWORD

node run.mjs --web https://webinarliv.com --dry-run --i-know-this-is-prod   # plan + admin login, nothing made
```

Before each run against production:

- check that no customer session is live: admin **Sessions**, or `/api/internal/live-status`;
- remember that a run starts the on-demand box if it is down: about 2–4 min (about 4 min from go-live to the presenter publishing on 24 Oct). `run.mjs` waits for it (`--box-wait`, default 6 min) before the presenters join, printing `waiting for the video server (starting, 45 s so far, about 75 s left)` every 15 s, then waits for the audience stream within the same budget. The presenters wait for the room's **Join the webinar** button for `--box-wait` too. (The first run of 24 Oct failed on a cold box after a fixed 60 s.)

| # | Command | Looks for |
|---|---|---|
| 1 | `node run.mjs --web https://webinarliv.com --steps 50 --hold 60s --i-know-this-is-prod` | Smoke: everything joins, 0 stalls, server count 50 |
| 2 | `... --steps 50,200 --ramp 30s --hold 120s --api-load` | Chat fan-out to 200 event streams; API p95 |
| 3 | `... --steps 50,200,500 --ramp 30s --hold 120s --api-load --presenters 2` | Two presenters, 500 viewers |
| 4 | `... --steps 50,200,500,1000 --ramp 30s --hold 120s --api-load --presenters 3 --screen-share --workers 8` | The target. If `Mbit/s` flattens or the generator warns, split the viewers (below) |
| 5 | `... --steps 50,200,500 --origin https://<box>.sslip.io/live` | The box alone, without the CDN: its own LL-HLS ceiling |
| 6 | `node webrtc-attendees.mjs --web https://webinarliv.com --kind meeting --steps 3,6,9 --hold 60s --i-know-this-is-prod` | A 10-person meeting (host + 9), camera on, mic muted |

Add `--low-latency` to steps 1–5 to measure LL playback, which is what the box serves (`hlsVariant: lowLatency`, 1 s segments, 500 ms parts).

**More viewers than one generator can pull.** One droplet's NIC and cores run out somewhere past 500 viewers. `--generators` drives other droplets over SSH:

```bash
# On the lead generator, with SSH access (key in SSH_KEY, or ssh's default) to the others as root:
SSH_KEY=~/.ssh/loadgen node run.mjs --web https://webinarliv.com --steps 50,200,500 --ramp 30s --hold 120s \
  --generators 10.47.0.5,10.47.0.6 --extra-seats 1000 --engage --record --i-know-this-is-prod
```

- `--extra-seats N` is how many viewers the other generators run between them; without it each runs as many as this one (`--steps`' last value). The extra seats are split evenly: generator *g* takes its contiguous slice of `keys-extra.json` (`--from`) and its share of every step, so all of them ramp together.
- For each generator, `run.mjs` copies this kit (a tarball of `e2e/load`) to `/tmp/loadkit-<run>-<n>` (or uses `--generator-kit /opt/loadgen/e2e/load`, what `setup-generator.sh` installed), copies the seats, and starts `hls-viewers.mjs ... --start-at <t>` over SSH. Everyone starts at the same instant, `--extra-wait` (90 s) after the seats are minted. Their output is streamed with a `[host]` prefix.
- At the end it collects each generator's results JSON, deletes the copy, prints each generator's table and then **all generators merged per step**: counts, bytes and active viewers added up, latency percentiles from the merged samples (exact enough; `approx` marks a step merged from summaries only). The generators' own `cpu%` and `loop99` are per generator (`hlsAll[].generators` in `results.json`), not added up.
- `--max-viewers` is the total. When you did not set it, it is raised to fit this generator plus the extra seats, with a printed note (24 Oct: "10 + 1000 extra viewers is over --max-viewers 1000"). Set it explicitly to keep a cap. The hard cap is 5000 seats.
- The generators need Node 22 and nothing else (no admin credentials: they use the minted seats).

Without `--generators`, `--extra-seats N` prints the `hls-viewers.mjs` command and waits `--extra-wait` for you to start it by hand on the other droplets (copy `results/<run>/keys-extra.json` across; split it with `--from`/`--steps`). The server's viewer count covers every generator either way.

### Checks: what PASS and FAIL mean

Two optional checks end in a PASS/FAIL table (and `checks`/`checksPass` in `results.json`; the exit code is 1 on a FAIL). Cleanup runs either way.

**`--engage`** runs `engage.mjs` once the top step's ramp is done (`(steps − 1) × (ramp + hold) + ramp` after the viewers start), from the viewers' seats:

1. a chat burst: `--engage-chat 200` messages, each tagged `ENG<id> message <i>`, one every 200 ms;
2. `--engage-questions 20` questions, then `--engage-upvotes 60` upvotes from other seats (never a seat's own question, never one question twice from a seat);
3. `--engage-polls 3` polls and `--engage-quizzes 2` quizzes, one at a time: create, open, `--engage-voters 100` seats vote choice *i* mod options (so the tally is known), close. Opening a poll closes the one that was open, so `run.mjs` pauses `--api-load`'s votes meanwhile and reopens its poll afterwards. api-load counts a 409 on a vote (poll closed meanwhile) as `voteConflict`, not as an error.

Then it reads what the server kept, as the host:

| Check | PASS when |
|---|---|
| chat | `GET /host/webinars/{slug}/chat` (`{stats, messages}`) holds every message the server accepted, by id, with the same text (`message`) |
| questions | `GET /webinars/{slug}/questions` (as the host) lists every accepted question |
| upvotes | each of those questions has exactly the upvotes that were accepted for it |
| each poll / quiz | its stored `votes` equal the accepted votes per option, it is `closed`, and a quiz still has its `correctOption` |

A send the server refused (429 rate limit, 409) is reported in the JSON but is not a FAIL: only what it said yes to has to be there. A FAIL means it accepted something and then lost or miscounted it, or a read failed.

**`--record`** grants the test host `cloud_recording` (`PATCH /admin/users/{id}/features`), starts a cloud recording (`POST /host/webinars/{slug}/recordings`) once the audience stream is live, and at the end stops it (`POST .../recordings/{id}/complete?durationMs=`), then:

| Check | PASS when |
|---|---|
| ready | `GET .../recordings` shows it `ready` within `--record-wait` (10 min) |
| size | `sizeBytes` > 0 |
| duration | `durationMs` within ±max(15 s, 20 %) of the time it was recording |
| playable | `GET .../recordings/{id}/file` with `Range: bytes=0-4095` (following the redirect to the CDN or a presigned URL) answers 200/206 with MP4 (`ftyp`/`moof`) or WebM (EBML) bytes |

The recording is deleted with the webinar at cleanup (`--keep` keeps both).

**The playback URL.** If the audience stream's playback URL is the box itself (a bare IP or `*.sslip.io`) and you did not ask for `--origin`, `run.mjs` prints a banner and repeats it under **Warnings** at the end: every viewer loaded the origin, so the numbers are the box's, not the CDN's.

### Server metrics in the results (optional)

With `GRAFANA_PROM_URL` (the stack's Prometheus base, e.g. `https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom`; a `/push` URL is accepted) and `GRAFANA_PROM_TOKEN` (a `metrics:read` token; `GRAFANA_PROM_USER` for Basic auth), `run.mjs` queries, for each step, averaged over the step: the box's busy cores, network out and in (Mbit/s), and MediaMTX's HLS bytes out. They are printed as a **Server (Grafana)** table and stored as `serverMetrics`. `GRAFANA_PROM_BOX` picks the box label (default `sfu-blr-1`). `GRAFANA_PROM_QUERIES='{"name":"promql"}'` replaces the queries (`$box` and `$window` are filled in): that is the hook for the API's p95 and 5xx, which the API does not export to Prometheus today (they are in Cloud Run's metrics). Without the variables nothing is queried.

**Several viewer generators** (as in the 24 Oct run 6: 1 presenter generator + 4 × 250 viewers):

- `run.mjs` checks the total against `--max-viewers` (default 1,000; hard cap 5,000). Its own viewers plus `--extra-seats` count, so 10 + 1,000 extra needs `--max-viewers 1010` or more. `hls-viewers.mjs` has the same flag, per generator.
- Give the copying time with `--extra-wait`, e.g. `360s`. `run.mjs` prints one command for all the extra seats; it is fine to change its `--steps` / `--ramp` / `--hold` per generator, as long as every generator keeps the same `--start-at`.
- Give each generator its own slice with `--from`: with 4 × 250, use `--from 0`, `250`, `500` and `750`, each with `--steps ... ,250`. Steps count that generator's own viewers.
- Keep the presenter generator free of viewers (a few for a reference are fine; they are useful as a control).
- Check that the `audience stream:` line is the CDN host (`*.b-cdn.net`), not the box. On the morning of 24 Oct it was the box, and five runs measured origin-direct delivery without anyone noticing.

**Interrupted?** Ctrl-C stops and cleans up. If the generator itself died, run `node run.mjs --cleanup results/<run>/state.json --i-know-this-is-prod`. The state file is 0600. It holds the throwaway test host's password; that account is deleted at cleanup.

### Trying it locally

1. Unit and end-to-end tests against a fake LL-HLS origin and API: `node --test e2e/load/test/*.test.mjs`.
2. Against a local stack:
   - Run the API with `BROADCAST_RTMP_BASE=rtmp://127.0.0.1:1/live` and `BROADCAST_HLS_BASE=http://127.0.0.1:18090/live`, plus `ADMIN_EMAILS` / `ADMIN_PASSWORD` and LiveKit (`infra/bin/livekit-server`).
   - Run `node e2e/load/test/fake-origin.mjs 18090` as the stream.
   - Build and start the web app with `next build && next start`. Headless Chrome did not hydrate the `next dev` build.
3. Then:

```bash
PROBE_ADMIN_EMAIL=... PROBE_ADMIN_PASSWORD=... node e2e/load/run.mjs --web http://127.0.0.1:3000 \
  --api http://127.0.0.1:8080/api --steps 3,6 --ramp 2s --hold 30s --presenters 2 --api-load --low-latency
```

## What to watch

**Grafana Cloud**, dashboard `webinarliv-overview` (stack pinkcloset2587). The box reports from boot (`deploy/livekit-hetzner/README.md`, "Grafana Cloud"). Filter `box=sfu-blr-1`.

| Metric | Read it as |
|---|---|
| `node_cpu_seconds_total{box}` (CPU by mode) | The box's CPU. `4 - sum(rate(...{mode="idle"}[1m]))` is busy cores. `softirq` is the kernel's network work, `nice` the captions agent and the mix recorder. The edge mix (compositor + x264) measured ~0.6-0.8 cores average, 1.3-1.7 peak, at 720p30 with two cameras (the egress logs its own `avgCPU`/`maxCPU` in its `egress metrics` line); it does not grow with viewers. With the CDN in front, viewers should barely move the rest |
| `container_cpu_usage_seconds_total` by `service` | Which part is busy: `egress`, `mediamtx`, `caddy`, `livekit`, `captions`, `mixrec`, `alloy` (cAdvisor, `job="cadvisor"`; the compose service is the `service` label, the container name `name`) |
| `process_cpu_seconds_total{job="livekit"}` | The SFU process alone. MediaMTX exports no process series; use the container series for it |
| `rate(hls_muxers_outbound_bytes[1m])` | Bytes MediaMTX sends out as HLS, i.e. what the origin serves (CDN shield and direct viewers alike). Through the CDN this should be a few Mbit/s whatever the audience; if it tracks viewers × ~1.8 Mbit/s, viewers are reaching the origin |
| `paths_readers`, `hls_sessions` | MediaMTX path readers and HLS sessions (MediaMTX metrics carry no `mediamtx_` prefix). Both stay at 1 per live path with or without a CDN: Caddy's `hlsCDNSecret` makes every request one shared session, so they are not a viewer count |
| `paths{name}`, `rtmp_conns{state="publish"}` | The edge mix publishing `live/<slug>`, and `rec/<slug>` while it is recorded (the same encode, a second RTMP output) |
| `livekit_participant_total`, `livekit_room_total` | The stage: presenters plus the egress recorder. Edge viewers are not LiveKit participants |
| `node_network_transmit_bytes_total` (rate) | Box egress. With `--origin` it should be about viewers × 1.8 Mbit/s. Through the CDN it should stay small; if it does not, check the `audience stream:` line `run.mjs` prints: that is the playback URL viewers get, and it has to be the pull zone, not the box |
| Logs (Loki), `{box="sfu-blr-1"}` | MediaMTX muxer errors, Caddy 5xx, egress restarts |

**Cloud Run** (GCP console, the API service). Every viewer holds one event stream, so 1000 viewers are 1000 concurrent requests, and the service allows `CONCURRENCY` (500) × `MAX_INSTANCES` (3) = 1500 at once. Watch:

- the instance count;
- concurrent requests per instance;
- request latency p95/p99, with `/join`, `/say`, `/events/beat` in the logs;
- 429 and 5xx counts.

**The database** (Supabase): connections and CPU. Beats upsert `attendance_visits`, and chat fans out through `LISTEN/NOTIFY`.

**The CDN** (Bunny): status codes (`4xx`, `503`) and origin requests per second. Bunny's cache-hit ratio is **not** a good health signal for LL-HLS: every blocking playlist reload is a new URL, and coalesced requests most likely count as misses (6.5% for the month, while the origin served about one stream). The offload signal is **origin egress**: `hls_muxers_outbound_bytes` and box network out should stay flat as viewers grow.

## Reading the results

| | Healthy | Investigate |
|---|---|---|
| `joinFail` | 0 | 409 `room_full`: load-test viewers too low. 429: ramp too fast. 5xx: API |
| `stalls` | ≈ 0 per step; a handful at most across 1000 viewers | Many, with `media95` near or above the part duration: origin or CDN slow. Many, with low `media95`: playlist blocking or generator CPU |
| `playlist 400` | A few, each followed by `playlistRecovered` | Thousands: a viewer is repeating stale directives (a kit bug; see "The stream" above). Check that `playlistRecovered` keeps pace. The 503s, timeouts and `neterr` that trigger the 400s are the real CDN signal |
| `live95s` | LL: under 3–4 s. Standard: under 10 s | Growing step over step: the stream falls behind (box CPU, egress encoder) |
| `media95` (LL) | ≪ 500 ms through the CDN | Close to 500 ms: viewers cannot keep up |
| server viewers vs `active` | Equal within about 30 s | Lower: beats or event streams being dropped (Cloud Run concurrency, timeouts) |
| `sseOpen` | = `active` | Lower: event streams failing (`events ...` in `errors`) |
| api-load p95 | Under 300 ms | Rising with viewers: the API is the bottleneck (fan-out, database) |
| presenters | 1280x720, ~30 fps, no `limited` | `limited: cpu` on the generator is the generator. `bandwidth` is the uplink to the box |

Results are written to `results/<run>/`: `plan.json`, `results.json` and `keys.json` (+ `keys-extra.json`). `results.json` holds every step (`hls`, and with generators `generators[]` and the merged `hlsAll`), the server counts, presenter samples, API windows, `engage`, `recording`, `serverMetrics`, `warnings` and `checksPass`.

## Honest limits

- **The generator is the first suspect.** Each step reports the generator's `cpu%` (summed over worker processes; 100 = one core) and event-loop p99 (`loop99`). The kit prints `WARNING` lines when they say the numbers are generator-bound (loop p99 > 200 ms, or CPU over 85% of the processes' cores). Believe them before believing a server limit.
- **Bandwidth.** 1000 viewers at ~1.8 Mbit/s is ~1.8 Gbit/s into one droplet, more than a droplet can be relied on to pull. Watch `Mbit/s` against viewers × bitrate, and `iftop` on the generator. Split with `--generators` at 500+.
- **Connections.** Node's fetch pools keep-alive connections per process, so N viewers use fewer TCP and TLS connections than N browsers would. Connection setup at the CDN and the origin is under-tested. Request rates are not.
- **One place, one IP per generator.** Every viewer on a generator comes from one IP in BLR1, hits one CDN POP, and has near-zero RTT to the box. Real viewers are spread across India and mobile networks. At 250 viewers per generator (about 3,000 requests/s from one IP) through Bunny, playlists failed with `400`/`503` while 10 viewers on another generator played cleanly (2026-10-24 run 6). Until that is explained, keep each generator at 125 or fewer viewers through the CDN, and run a single-IP control separately.
- **Retries.** After a failed blocking playlist reload, a kit viewer waits 1 s and retries the same URL indefinitely. hls.js has its own retry and back-off policy, so a browser may recover differently. Confirm stalls with a real browser tab.
- **No decoding, no ABR, no LL step-up.** The model follows the playlist and the network only. A viewer's CPU or a bad Wi-Fi link is not represented. Force `--low-latency` to test LL playback.
- **Presenters** run in the same datacenter as the box (a perfect uplink), and their Chrome encodes in software on the generator.
- **WebRTC webinar audiences** cannot be tested on the DigitalOcean box: every webinar there is edge. `webrtc-attendees --kind webinar` is for a server with standard delivery. Meetings (`--kind meeting`) are WebRTC everywhere. The default meeting cap is 10 (host included); probe-load raises the host's cap (admin `meeting-cap`, up to 50) when you ask for more.
- **Production runs so far:** [2026-10-24-report.md](load-tests/2026-10-24-report.md) (runs 1-5, origin-direct: read its correction note) and [2026-10-24-run6-cdn-1000.md](load-tests/2026-10-24-run6-cdn-1000.md) (1,010 viewers through the CDN).
