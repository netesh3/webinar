# Self-hosted LiveKit on Hetzner

Minimum viable SFU for ~200 webinar subscribers.

| Item | Value |
|------|--------|
| Server | `webcast-livekit` · **CX33** (4 vCPU / 8 GB) · `fsn1` |
| IPv4 | see `hcloud server describe webcast-livekit` |
| Domain | `*.sslip.io` pointing at that IP (TLS via Caddy) |
| Cost | hourly; ~€8.49/mo if left on 24/7 (EU) |

## Install / reinstall

```bash
scp -i ~/.ssh/hetzner_sancharees deploy/livekit-hetzner/* root@SERVER:/opt/livekit/
ssh -i ~/.ssh/hetzner_sancharees root@SERVER \
  'DOMAIN=IP.sslip.io ACME_EMAIL=you@example.com bash /opt/livekit/install.sh'
```

Keys live in `/opt/livekit/.env.keys` (not in git). Point Cloud Run at:

- `LIVEKIT_URL=wss://IP.sslip.io`
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from `.env.keys`

## Stop paying

```bash
hcloud server delete webcast-livekit
hcloud firewall delete webcast-livekit-fw
```

Sancharees (`sancharees` CX23) is untouched.
