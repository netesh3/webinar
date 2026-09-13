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

## Prometheus metrics (temporary, for a performance-test window)

`livekit.yaml.template` sets `prometheus_port: 7801` — not reachable from the
internet (`install.sh`'s ufw is an allow-list and 7801 is not on it), so reach
it over an SSH tunnel instead of opening a firewall rule for it:

```bash
ssh -i ~/.ssh/hetzner_sancharees -L 7801:localhost:7801 root@88.198.141.104
```

Then `curl -s localhost:7801/metrics` (or point a local Prometheus at it) on
the machine you ran the tunnel from. Remove the `prometheus_port` line from
`livekit.yaml.template` and redeploy once the test is done — it costs nothing
left in place, but a port only used for one afternoon is one less thing to
remember is there.

## Stop paying

```bash
hcloud server delete webcast-livekit
hcloud firewall delete webcast-livekit-fw
```

Sancharees (`sancharees` CX23) is untouched.
