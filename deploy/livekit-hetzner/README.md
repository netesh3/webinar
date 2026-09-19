# Self-hosted LiveKit on Hetzner

Minimum viable SFU for ~200 webinar subscribers.

| Item | Value |
|------|--------|
| Server | `webcast-livekit` · **CX33** (4 vCPU / 8 GB) · `fsn1` |
| IPv4 | `88.198.141.104` (or `hcloud server describe webcast-livekit`) |
| Domain | `88.198.141.104.sslip.io` (TLS via Caddy) |
| Cost | hourly; ~€8.49/mo if left on 24/7 (EU) |
| Host path | `/opt/livekit` |

## CI auto-deploy

GitHub Actions workflow **Deploy LiveKit (Hetzner)** (`.github/workflows/livekit-hetzner-deploy.yml`):

- **Auto:** push to `main` when `deploy/livekit-hetzner/**` (or the workflow) changes
- **Manual:** Actions → workflow_dispatch

It rsyncs compose/Caddyfile/template/scripts to `/opt/livekit`, runs `redeploy.sh`
(regenerates `livekit.yaml` from the template + existing `.env.keys`, preserves
`node_ip` / `use_external_ip`), then `docker compose pull && up -d`.

**Never overwritten:** `.env.keys`, `.env`, and the generated `livekit.yaml` during
rsync (yaml is regenerated on the server). API keys are **not** rotated unless
`.env.keys` is missing (fresh `install.sh` only).

Repo secrets: `HETZNER_SSH_HOST` (`root@88.198.141.104`), `HETZNER_SSH_PRIVATE_KEY`.

## Install / reinstall (first boot)

```bash
scp -i ~/.ssh/hetzner_sancharees deploy/livekit-hetzner/* root@SERVER:/opt/livekit/
ssh -i ~/.ssh/hetzner_sancharees root@SERVER \
  'DOMAIN=IP.sslip.io ACME_EMAIL=you@example.com bash /opt/livekit/install.sh'
```

Manual refresh after editing files locally:

```bash
rsync -az --exclude '.env.keys' --exclude '.env' --exclude 'livekit.yaml' \
  -e 'ssh -i ~/.ssh/hetzner_sancharees' \
  deploy/livekit-hetzner/ root@SERVER:/opt/livekit/
ssh -i ~/.ssh/hetzner_sancharees root@SERVER '/opt/livekit/redeploy.sh'
```

Keys live in `/opt/livekit/.env.keys` (not in git). Point Cloud Run at:

- `LIVEKIT_URL=wss://IP.sslip.io`
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from `.env.keys`

## Metrics: Prometheus + Grafana (always on)

The compose stack runs Prometheus (scraping LiveKit's `/metrics` on
`127.0.0.1:7801`) and Grafana, both bound to localhost and reached only
through Caddy — same allow-list-firewall reasoning as everywhere else in this
directory, so no new `ufw allow` rules are needed:

- **Dashboard:** `https://<domain>/grafana/` — user `admin`.
- **Password — no SSH needed:** set repo secret `GRAFANA_ADMIN_PASSWORD`
  (GitHub → repo → Settings → Secrets and variables → Actions → New
  repository secret) to whatever password you want, then trigger a deploy
  (push to `deploy/livekit-hetzner/**`, or Actions → **Deploy LiveKit
  (Hetzner)** → Run workflow). `redeploy.sh` picks it up over SSH and writes
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

## Live attendee origin (LL-HLS)

CDN-broadcast attendees watch a mixed program, not SFU tracks. Egress already
composites the room; this path pushes that composite to MediaMTX over RTMP and
serves **LL-HLS** from Caddy instead of 2-second files on B2 (~15s lag).

| Piece | Where |
|---|---|
| MediaMTX | `docker-compose.egress.yml` · `127.0.0.1:1935` RTMP, `:8888` HLS |
| Public playlist | `https://live.webinarliv.com/live/<slug>/index.m3u8` |
| Fallback | existing B2/API `live.m3u8` if MediaMTX is not publishing yet |

This is live. `BROADCAST_RTMP_BASE` and `BROADCAST_HLS_BASE` are set as repo
secrets, so joins hand out the LL-HLS URL with the B2 playlist as fallback.
Clearing either secret reverts every attendee to B2 — that is the rollback, and
it needs no code change.

**`BROADCAST_HLS_BASE` must be the Cloudflare hostname, not the SFU's.**
`88.198.141.104.sslip.io` resolves straight to the box, so pointing at it
would cut lag to a few seconds and cap the audience at whatever 1 Gbps
divided by the bitrate allows — a worse trade than the 15s it replaces. The
edge is what makes this scale: it fetches each HLS part once no matter how
many people are watching.

What is configured, should any of it need rebuilding:

1. DNS: `live.webinarliv.com` → `88.198.141.104`, **proxied** (orange cloud).
   The zone runs SSL mode Full, which is why the Caddyfile gives this hostname
   `tls internal` — behind the proxy a public ACME order cannot reliably
   complete, and Full accepts a locally-issued origin certificate. Un-proxying
   this record is an outage, not a fallback.
2. Cache Rule "Cache LL-HLS on live origin": `http.host eq "live.webinarliv.com"`
   → eligible for cache, Edge TTL from the origin's `Cache-Control`. Without a
   rule Cloudflare treats `.m3u8`/`.m4s` as uncacheable (`cf-cache-status:
   DYNAMIC`) and every viewer reaches the origin — the exact cost this design
   exists to avoid. Verify with `curl -I` after any cache change.
3. Repo secrets `BROADCAST_RTMP_BASE=rtmp://127.0.0.1:1935/live` and
   `BROADCAST_HLS_BASE=https://live.webinarliv.com/live`.

The zone is on Cloudflare's **free** plan, whose terms restrict serving large
volumes of video. This is fine for current traffic but is a business risk at
scale, not a technical one — the fix is a paid plan or Cloudflare Stream.

## Stop paying

```bash
hcloud server delete webcast-livekit
hcloud firewall delete webcast-livekit-fw
```

Sancharees (`sancharees` CX23) is untouched.
