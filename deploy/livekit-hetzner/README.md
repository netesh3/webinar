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

## Stop paying

```bash
hcloud server delete webcast-livekit
hcloud firewall delete webcast-livekit-fw
```

Sancharees (`sancharees` CX23) is untouched.
