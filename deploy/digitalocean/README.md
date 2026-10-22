# DigitalOcean (Bangalore) — test video server

A third LiveKit SFU, in DigitalOcean's Bangalore region, running alongside Hetzner (`default`)
and Mumbai GCP (`india`) so meetings and edge webinars can be tried on DigitalOcean before
anything moves. Why DigitalOcean: meetings make SFU egress the main cost, and droplets include
pooled transfer (then ~$0.01/GiB) where GCP charges ~$0.12/GB. Nothing else has moved: the API
is still on Cloud Run, the database on Supabase, recordings on R2, the edge CDN on Bunny.

| Item | Value |
|------|--------|
| Droplet | `sfu-blr-1` · **c-4** (4 dedicated vCPU / 8 GB, 5 TB transfer) · `blr1` · Ubuntu 24.04 |
| Cost | $0.125/hour, $84/month if left on (DigitalOcean bills a powered-off droplet too) |
| Reserved IP | `152.42.156.192` (survives a rebuild; free while attached) |
| Domain | `152.42.156.192.sslip.io` (TLS via Caddy) |
| Firewall | `sfu-media`, applied by tag `webinar-sfu`: 22, 80, 443, 7881/tcp, 3478/tcp+udp, 50000–60000/udp |
| Project | DigitalOcean project `webinar-liv-prod` |
| Host path | `/opt/livekit` (the `deploy/livekit-hetzner` stack, egress on the box) |
| LiveKit project id | **`do-blr`**, label "Bangalore (DigitalOcean test)" |

## How it was built (2026-10-22)

```bash
doctl compute ssh-key import <name> --public-key-file ~/.ssh/id_ed25519.pub
doctl compute droplet create sfu-blr-1 --region blr1 --size c-4 --image ubuntu-24-04-x64 \
  --ssh-keys <key id> --enable-monitoring --tag-names webinar-sfu --project-id <project id> --wait
doctl compute reserved-ip create --droplet-id <droplet id>
doctl compute firewall create --name sfu-media --tag-names webinar-sfu --inbound-rules "…ports above…"

rsync -az deploy/livekit-hetzner/ root@152.42.156.192:/opt/livekit/
ssh root@152.42.156.192 \
  'DOMAIN=152.42.156.192.sslip.io ACME_EMAIL=<email> bash /opt/livekit/install.sh'
# Viewers are in India, so short LL-HLS parts, as on the Mumbai box:
ssh root@152.42.156.192 'echo HLS_PART_DURATION=250ms >> /opt/livekit/.env && /opt/livekit/redeploy.sh'
```

Keys are in `/opt/livekit/.env.keys` on the box (not in git). `docker compose ps` there needs
`--env-file .env --env-file .env.keys`.

## Registration

Appended to the `LIVEKIT_PROJECTS` GitHub secret, after `default` and `india`, so new rooms still
go to Hetzner unless an admin assigns a host to `do-blr` (Admin → Accounts → Video server):

```json
{
  "id": "do-blr",
  "label": "Bangalore (DigitalOcean test)",
  "url": "wss://152.42.156.192.sslip.io",
  "key": "<API_KEY from .env.keys>",
  "secret": "<API_SECRET from .env.keys>",
  "broadcastHlsBase": "https://152.42.156.192.sslip.io/live",
  "edgePlaybackBase": "https://152.42.156.192.sslip.io/live"
}
```

`edgePlaybackBase` points straight at the box for the test (Caddy sets MediaMTX's CDN secret, so
direct viewers get one shared, cacheable session). Put a Bunny pull zone in front of it before
real audiences. Then re-run **Deploy API (Cloud Run)**. See [ADDING-AN-SFU.md](../../docs/ADDING-AN-SFU.md).

Not covered by CI: the Hetzner deploy workflow only targets Hetzner, so changes to
`deploy/livekit-hetzner/**` reach this box only by the rsync + `redeploy.sh` above.

## Account limits

Tier 2: 10 droplets, 10 reserved IPs, 1 load balancer — enough for this box, the API and a few
egress workers. When more are needed: Account → Resource Limits → **Increase your limit**, either
Prepay (instant) or a free support ticket (1–2 business days); ask for ~25 droplets.

## Removing it

Unassign any host from `do-blr` (or set `"disabled": true` on the entry and redeploy the API),
then `doctl compute droplet delete sfu-blr-1`, `doctl compute reserved-ip delete 152.42.156.192`
(an unattached reserved IP bills $5/month) and `doctl compute firewall delete <id>`.
