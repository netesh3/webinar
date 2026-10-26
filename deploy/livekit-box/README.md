# Self-hosted LiveKit box (the video-server stack)

The stack every video server runs: LiveKit, Egress (the mix), MediaMTX (the live HLS origin),
the mix recorder, Caddy, Prometheus/Grafana and Alloy. Today that is the on-demand
DigitalOcean box (`deploy/digitalocean/`: `sfu-boot.sh`, `build-image.sh`, the
`webinar-sfu-image` snapshot) and any extra box slots (`SFU_BOX_SLOTS`). This directory was
`deploy/livekit-hetzner/` until 2026-10-26, named after the first server; that Hetzner server
was deleted on 2026-10-26 (`docs/HETZNER-SUNSET.md`).

| Item | Value (the DigitalOcean box) |
|------|--------|
| Server | `sfu-blr-1`, created on demand from the newest `webinar-sfu-image` snapshot |
| Domain | `<reserved IP>.sslip.io` (TLS via Caddy) |
| Host path | `/opt/livekit` (a link to the `sfu-data` volume) |

## CI auto-deploy

**Deploy LiveKit (DigitalOcean)** (`.github/workflows/livekit-do-deploy.yml`) is the only
workflow that deploys this stack:

- **Auto:** push to `main` when `deploy/livekit-box/**` (or the workflow) changes
- **Manual:** Actions → workflow_dispatch

It rsyncs compose/Caddyfile/template/scripts to `/opt/livekit`, runs `redeploy.sh`
(regenerates `livekit.yaml` from the template + existing `.env.keys`, preserves
`node_ip` / `use_external_ip`), then `docker compose pull && up -d`. A box that is down gets
the files at its next boot instead (`sfu-boot.sh` syncs this directory from the repo).

**Never overwritten:** `.env.keys`, `.env`, and the generated `livekit.yaml` during
rsync (yaml is regenerated on the server). API keys are **not** rotated unless
`.env.keys` is missing (fresh `install.sh` only).

## Install on a new server (first boot)

The on-demand box never runs this: its keys and certificates are on the `sfu-data` volume
(deploy/digitalocean/README.md). For a server of your own (docs/ADDING-AN-SFU.md):

```bash
scp deploy/livekit-box/* root@SERVER:/opt/livekit/
ssh root@SERVER 'DOMAIN=IP.sslip.io ACME_EMAIL=you@example.com bash /opt/livekit/install.sh'
```

Manual refresh after editing files locally:

```bash
rsync -az --exclude '.env.keys' --exclude '.env' --exclude 'livekit.yaml' \
  deploy/livekit-box/ root@SERVER:/opt/livekit/
ssh root@SERVER '/opt/livekit/redeploy.sh'
```

Keys live in `/opt/livekit/.env.keys` (not in git). Add the server to `LIVEKIT_PROJECTS` with
its own `url`, `key` and `secret` (docs/ADDING-AN-SFU.md).

## Metrics: Prometheus + Grafana (always on)

The compose stack runs Prometheus (scraping LiveKit's `/metrics` on
`127.0.0.1:7801`) and Grafana, both bound to localhost and reached only
through Caddy — same allow-list-firewall reasoning as everywhere else in this
directory, so no new `ufw allow` rules are needed:

- **Dashboard:** `https://<domain>/grafana/` — user `admin`.
- **Password — no SSH needed:** set repo secret `GRAFANA_ADMIN_PASSWORD`
  (GitHub → repo → Settings → Secrets and variables → Actions → New
  repository secret) to whatever password you want, then trigger a deploy
  (push to `deploy/livekit-box/**`, or Actions → **Deploy LiveKit
  (DigitalOcean)** → Run workflow). `redeploy.sh` picks it up over SSH and writes
  it into the server's `.env.keys`, overwriting any previous value — so this
  also works to rotate the password later. Leave the secret unset and
  `redeploy.sh` self-heals with a random one instead, but then the only way
  to read it back is `ssh root@<ip> 'grep GRAFANA_ADMIN_PASSWORD
  /opt/livekit/.env.keys'`.
- **Provisioned dashboard:** "LiveKit SFU" — active rooms/participants
  (concurrency), published/subscribed track counts, CPU/memory, session join
  latency (p50/p95), track publish/subscribe outcomes, room duration
  (p50/p95). Source: `grafana-provisioning/dashboards/json/livekit.json`.
  Metric names were sourced from `livekit/livekit`'s
  `pkg/telemetry/prometheus` package plus the standard Prometheus Go client
  process collector (`process_cpu_seconds_total`,
  `process_resident_memory_bytes`) — spot-check panel 7's `state` label
  against the live `/metrics` output after first deploy, since it was sourced
  from a doc/source lookup rather than a live scrape.
- **Ad-hoc PromQL / raw scrape:** either through Grafana's Explore tab, or
  still over an SSH tunnel if you want it outside Grafana:
  `ssh -L 7801:localhost:7801 root@<ip>` then `curl -s localhost:7801/metrics`.
- **Retention:** 15 days (`prometheus.yml` + the `--storage.tsdb.retention.time`
  flag in `docker-compose.yml`).

### Grafana Cloud (Alloy, optional)

`docker-compose.alloy.yml` runs [Grafana Alloy](https://grafana.com/docs/alloy/)
(`grafana/alloy:v1.21.2`, host network, UI on `127.0.0.1:12345` only) with
`alloy/config.alloy`. It ships, to Grafana Cloud:

| What | Source | Job label |
|---|---|---|
| LiveKit metrics | `127.0.0.1:7801` | `livekit` |
| MediaMTX metrics | `127.0.0.1:9998` (`metrics: true` in `mediamtx.yml.template`, loopback only, not in ufw, the cloud firewall or the Caddyfile) | `mediamtx` |
| Host metrics | embedded node_exporter (`prometheus.exporter.unix`): CPU, memory, load, disk, filesystems, NIC, TCP/UDP counters, PSI | `node` |
| Container metrics | embedded cAdvisor: CPU, throttling, memory, OOMs per container (`name`, `service`). Reads the docker socket, the cgroup tree and containerd's socket (`/run/containerd/containerd.sock`: Docker's containerd image store needs it, or no container series appear at all) | `cadvisor` |
| Container logs | every container via the docker socket (read-only), labels `container`, `service`, `stream`; debug/trace lines dropped | - |

Every series and log line carries `box` (from `ALLOY_BOX` in `.env`, else the droplet's
hostname, e.g. `sfu-blr-1`) and `role="video"` (the on-demand captions box runs the same Alloy
with `role="captions"`, `deploy/digitalocean/README.md` "Captions box"). Series are trimmed to an allow-list (Go runtime series, per-CPU
guest modes, per-container network/disk/process series dropped) to stay well inside the free
tier's 10k active series; check **Cost management → Metrics** after the first day.

**Off until configured.** `redeploy.sh` starts Alloy only when `/opt/livekit/.env` has all five
of the settings below; with none it does nothing, with some it warns and does not start it.
Two writers put them there, both replacing all five `GRAFANA_CLOUD_*` lines (so they agree and
re-running either changes nothing):

1. **The API, at every droplet create** (the usual path; the box is normally off). The Cloud Run
   deploy passes the same repo variables and secret to the API as env vars; the box manager
   (`boxUserData`, `api/internal/api/sfu_box.go`) writes them into the droplet's user data as a
   root-only file `/run/webinarliv-grafana.env`, and `deploy/digitalocean/sfu-boot.sh` merges it
   into the volume's `.env` before `redeploy.sh`, then deletes it. All five or none: the API
   refuses to boot on a partial set while `SFU_BOX_PROJECT` is set. Nothing logs the values.
2. **The deploy workflow** (**Deploy LiveKit (DigitalOcean)**), when it finds the box up.

That `.env` is on the `sfu-data` volume, so the settings also survive for a droplet created
before the API had them. The Alloy image is in the snapshot (`deploy/digitalocean/build-image.sh`).
Anything running on the droplet can read its user data (the metadata service), so the token
must be the write-only access policy token below and nothing broader.

| Name | Kind | Where in Grafana Cloud |
|---|---|---|
| `GRAFANA_CLOUD_PROM_URL` | variable | Stack → Prometheus → Details → Remote Write Endpoint (`https://prometheus-prod-…/api/prom/push`) |
| `GRAFANA_CLOUD_PROM_USER` | variable | same page, Username / Instance ID (a number) |
| `GRAFANA_CLOUD_LOKI_URL` | variable | Stack → Loki → Details → URL, plus `/loki/api/v1/push` |
| `GRAFANA_CLOUD_LOKI_USER` | variable | same page, User (a number) |
| `GRAFANA_CLOUD_TOKEN` | **secret** | Administration → Cloud access policies: a policy with `metrics:write` and `logs:write`, then a token for it |

```bash
gh variable set GRAFANA_CLOUD_PROM_URL  --body 'https://prometheus-prod-XX-prod-ap-south-1.grafana.net/api/prom/push'
gh variable set GRAFANA_CLOUD_PROM_USER --body '1234567'
gh variable set GRAFANA_CLOUD_LOKI_URL  --body 'https://logs-prod-XXX.grafana.net/loki/api/v1/push'
gh variable set GRAFANA_CLOUD_LOKI_USER --body '765432'
gh secret set GRAFANA_CLOUD_TOKEN        # paste the token at the prompt
gh workflow run cloudrun-deploy.yml      # the API passes them to every new droplet
gh workflow run livekit-do-deploy.yml    # only if the box is up now: writes them and starts Alloy
```

The box deploy skips while the on-demand box is down; the next droplet the API creates reports
from boot regardless. To turn Alloy off, remove the lines from the box's
`.env` (`ssh root@<box> "sed -i '/^GRAFANA_CLOUD_/d' /opt/livekit/.env && /opt/livekit/redeploy.sh"`)
and delete the variables and secret, then redeploy the API, so neither the next box deploy nor the
next droplet writes them back. Check it on the box:
`docker compose -f docker-compose.yml -f docker-compose.alloy.yml logs alloy`, or the UI
through `ssh -L 12345:127.0.0.1:12345 root@<box>`.

The local Prometheus and Grafana above still run; once Grafana Cloud has the dashboards you
want, they can be removed in a later change.

### TURN relay vs. direct (item #2 — not a LiveKit Prometheus metric)

LiveKit's own Prometheus metrics don't expose per-connection ICE path
(direct vs. relayed through TURN) — confirmed by reading
`pkg/telemetry/prometheus`, which only covers room/participant/track/session
counters. That data only exists client-side, on the browser's own
`RTCPeerConnection` stats, so it's reported through the existing (flag-gated)
telemetry pipe instead: `web/lib/telemetry.ts` now samples the nominated
`candidate-pair`'s local `candidateType` (`host` / `srflx` / `relay`) once per
quality-poll cycle and pushes a `connection_type` event on change. It lands
in the same Cloud Logging JSON as the rest of `/telemetry` — filter on
`jsonPayload.event="connection_type"` and `jsonPayload.metrics.candidateType`
to see the relay ratio.

### Database and Cloud Run (items #3 / #4 — no new code)

Both already have first-party dashboards; wiring a second, weaker copy of
either isn't worth it:

- **Supabase/Postgres:** Project → Database → Reports for connection-pool
  usage, and Database → Query Performance for slow queries. Watch pool
  exhaustion first — it's the metric most likely to bite before raw CPU does
  at this scale.
- **Cloud Run:** the service's Metrics tab in Cloud Console (or `gcloud
  monitoring` / the Cloud Monitoring dashboard) already covers request count,
  latency, container CPU/memory, and instance count — all free, no
  instrumentation needed.

### Concurrency over time (item #5 — comes free with the dashboard above)

Prometheus is already a time-series store, so "peak concurrent participants
over days/weeks" is just the existing `livekit_participant_total` panel with
a wider time range / a `max_over_time(...)` query in Grafana — no separate
tracking needed once the dashboard above is live.

## Live origin (Edge delivery)

Edge webinars' audiences watch a mixed program, not SFU tracks. Egress composites the room
(on this box, or on egress workers in remote-egress mode) and pushes RTMP to MediaMTX, which
repackages it as **plain HLS** (1 s fMP4 segments; LL-HLS was dropped on 2026-10-26,
docs/decisions/2026-10-26-audience-delivery.md) without re-encoding. Caddy serves it on `/live/<slug>/index.m3u8`,
and viewers play it through a CDN pull zone (Bunny) or directly. See `docs/edge-delivery.md`.

| Piece | Where |
|---|---|
| MediaMTX | `docker-compose.egress.yml` · `:1935` RTMP in, `127.0.0.1:8888` HLS out (behind Caddy) |
| Public origin | `{BROADCAST_HLS_BASE}/<slug>/index.m3u8`, or the project's `edgePlaybackBase` |

### Recording from the mix (optional)

Cloud recording of an Edge webinar used to start a second Chrome compositor beside the mix,
which a box with one compositor's worth of CPU (DigitalOcean c-4) refuses. With the mix
recorder on, **Record** instead gives the running mix a second RTMP output,
`rtmp://<origin>/rec/<slug>`: the same encoded stream (egress tees it, as it does for YouTube),
so no new encode and the audience's `live/<slug>` is never touched. MediaMTX records every
`rec/*` path to fMP4 segments in `/opt/livekit/recordings/rec/<slug>/`. The **mix recorder**
(`mixrec/`, `docker-compose.mixrec.yml`, `127.0.0.1:7895`, behind Caddy on `/mixrec/*`) gets
start/stop from the API, waits for the segments to close, joins them into one MP4
(`ffmpeg -c copy`), PUTs it to the recording's storage key through a URL the API signs, and
reports size and duration to `POST /api/internal/mix-recordings/{id}/complete`. The recording
then shows in the Recording tab like any other. No bucket credentials on the box.

Works in remote-egress mode too: the rec URL uses the same host as `BROADCAST_RTMP_BASE`, so
the workers push it to this box's MediaMTX over the VPC like the mix itself.

To turn it on:

1. Generate one secret: `openssl rand -hex 32`.
2. API (Cloud Run): `MIXREC_SECRET=<it>`. Needs `RECORDINGS_MODE=egress` and
   `RECORDINGS_BACKEND=s3`. The recorder is found at the live origin with `/live` replaced by
   `/mixrec` (e.g. `https://<box>.sslip.io/mixrec`); set `MIXREC_URL` or the project's
   `mixRecorderUrl` in `LIVEKIT_PROJECTS` if it lives elsewhere.
3. This box, `/opt/livekit/.env`: `MIXREC_SECRET=<it>`, and `MIXREC_API_URL` if the API is not
   `https://webinarliv.com`. Optional: `MIXREC_CPUS` (default 1), `MIXREC_IMAGE`.
4. `redeploy.sh` (CI does it on push): builds `mixrec/`, starts it, and adds the `rec/*`
   recording path to MediaMTX. Check `curl https://<box>/mixrec/v1/health` → `ok`.

Fallback, in order: no mix running (standard delivery, or the mix not up yet) → the usual
composite recording; recorder not configured, not answering, or the mix refusing the extra
output → a compositor of the recording's own (or `recording_no_capacity`), as before.
A mix that dies mid-recording is restarted with the recording output too, and the recorder
joins the segments either side of the gap. A job never stopped (the API unreachable) is
finished once its segments have been idle for 3 minutes. Segments are deleted after upload;
MediaMTX deletes anything left after 72 h. One PUT is at most 5 GiB (about 6 h at the default
edge bitrate).

### Clips and reels

The same container makes hosts' clips and reels (`mixrec/clips.go`; API side
`api/internal/api/clip_jobs.go`, behind the per-host `clips` switch). It asks the API for a
job every 30 s over `/api/internal/clip-jobs` with the same `MIXREC_SECRET`; the API hands out
none while a session is live or about to start on this box, and none while a mix recording
is in progress here. A job is ffmpeg reading just its stretches from signed URLs of the
recording, framing them for 9:16, 1:1 or 16:9, burning in captions and the hook title (libass
with Inter, `font-inter` in the image), normalising loudness to -14 LUFS, writing H.264/AAC
with `+faststart`, then a signed PUT. Under `nice 19` and `ionice -c 3`, 2 encoder threads,
inside `MIXREC_CPUS`; a 1080x1920 render peaks near 500 MB, hence the 1 GiB `mem_limit`
(`MIXREC_MEM`). Roughly 2x real time on one core. Progress every 20 s renews the job's lease; a
session going live sends the job back to the queue. Optional in `.env`: `MIXREC_CLIPS=off`,
`MIXREC_CLIP_THREADS`.

What the clips can frame: every recording is one mixed picture of the session as the audience
saw it (LiveKit room composite, the edge mix, or the browser's own canvas), never a separate
camera or per-person file, and the layout is not stored per recording (the host can change
it mid-session). So a vertical or square clip either keeps the whole picture over a blurred
copy of itself ("Whole picture", the default) or fills the frame with the middle, left or
right of it, chosen by the host. A 720p recording filled to 9:16 is upscaled about 2.7x and
looks soft; "Whole picture" does not upscale.

On the on-demand DigitalOcean box nothing starts the server for clips: they wait for the
next time it is up for a session. A clip being made keeps it up (never deleted mid-render),
and an admin's "Make it now" (`POST /api/admin/clips/make-now`) starts it for the queue; it
goes again as soon as the queue is made, without the 40-minute idle grace.

Until 2026-10-20 this box was also the **WHEP** origin of the CDN Broadcast mode (WebRTC on
UDP 8189, plus an ffmpeg per live mix re-encoding the audio to Opus). That mode was retired;
`redeploy.sh` closes 8189 on boxes that still had it open.

## TURN over TLS on 443 (optional, off)

For participants whose network lets out only TCP 443. Opt-in per box with `TURN_TLS_443=true`
in `/opt/livekit/.env`, then `redeploy.sh`; unset, nothing changes (stock Caddy, same
`livekit.yaml`). Enabled on the DigitalOcean box only when its README says so; steps and the
browser test are in `deploy/digitalocean/README.md`.

| Piece | What it does |
|---|---|
| `caddy-l4/Dockerfile` | Caddy 2.11 + `github.com/mholt/caddy-l4`, built on the box by `redeploy.sh` (first time a few minutes) |
| `docker-compose.turn443.yml` | Swaps the caddy image for that build and mounts `Caddyfile.turn443` as the Caddyfile, `Caddyfile` beside it as `Caddyfile.base` |
| `Caddyfile.turn443` | A layer4 listener wrapper on `:443`: TLS ClientHello with SNI `TURN_TLS_DOMAIN` → Caddy terminates TLS → plain TCP to `127.0.0.1:5349`; any other SNI falls through to the unchanged sites (`import Caddyfile.base`). A `TURN_TLS_DOMAIN` site block makes Caddy obtain and renew its certificate (HTTP-01 on :80, or TLS-ALPN-01, which the wrapper lets through) |
| `livekit.yaml` | `turn.domain: TURN_TLS_DOMAIN`, `tls_port: 5349`, `external_tls: true`, relay ports inside 50000–60000 (already open). LiveKit always advertises TLS TURN as `turns:<turn.domain>:443?transport=tcp` |

`TURN_TLS_DOMAIN` defaults to `turn.<DOMAIN>`: for a `<ip>.sslip.io` domain that resolves to the
same IP with no DNS work. On a real domain add the record (it must not be behind a proxying CDN)
or set `TURN_TLS_DOMAIN` in `.env`. 5349 is not in the ufw allow-list, so it is reachable only
through Caddy. `redeploy.sh` ends with a TURN/TLS health line (LiveKit on :5349 and a certificate
that verifies for the TURN name through :443; a warning, not a failure). The DO workflow also
builds the image and runs `caddy validate` on `Caddyfile.turn443`.

## Stop paying

The on-demand box is deleted by the API after a quiet spell; see deploy/digitalocean/README.md
("Cost") for what stays billable (the volume, the reserved IP, the snapshots).
