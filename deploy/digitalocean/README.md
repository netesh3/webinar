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

CI: **Deploy LiveKit (DigitalOcean)** (`.github/workflows/livekit-do-deploy.yml`) syncs
`deploy/livekit-hetzner/` and `deploy/captions/` here and runs `redeploy.sh` on every push to
main that changes them, like the Hetzner workflow. It needs the repo secrets `DO_SSH_HOST`
(`root@152.42.156.192`) and `DO_SSH_PRIVATE_KEY` (a deploy key in the box's
`authorized_keys`); without them it skips with a notice.

## Account limits

Tier 2: 10 droplets, 10 reserved IPs, 1 load balancer — enough for this box, the API and a few
egress workers. When more are needed: Account → Resource Limits → **Increase your limit**, either
Prepay (instant) or a free support ticket (1–2 business days); ask for ~25 droplets.

## Alerts

Set 2026-10-22. Both kinds email the account owner.

- **Spend alert** (Billing → Spend alerts): "Webinar Liv monthly cap", **$100/month**, total spend,
  thresholds 50 / 75 / 90 / 100 %. Expected spend is ~$84/month (this c-4), so a normal month
  stays under the 90 % mail and anything forgotten or runaway crosses it. **"Pause usage" is
  deliberately off**: it would stop resources, i.e. end live webinars. Raise the budget when a
  second video server or an API droplet is added (~$170–250).
- **Monitoring alerts** (`doctl monitoring alert list`), on every droplet tagged `webinar-sfu`,
  so a second SFU is covered by tagging it:

  | Metric | Fires at | Meaning |
  |---|---|---|
  | CPU | > 80 % for 10 min | near capacity: resize to c-8 or add a second SFU |
  | Memory | > 85 % for 10 min | same |
  | Disk | > 85 % for 5 min | logs or recordings filling the disk |
  | Public outbound | > 400 Mbps for 10 min | heavy meeting/webinar traffic; watch the 5 TB/month transfer |

## Server captions (optional, off)

The caption agent (`deploy/captions`: faster-whisper, English/Hindi/Hinglish, Roman script by
default) can run on this box beside egress. Not enabled. To try it: the same 32+ character
`CAPTIONS_SECRET` on the API (Cloud Run env) and in `/opt/livekit/.env` with
`CAPTIONS_ENABLED=true`, sync `deploy/captions/` to `/opt/livekit/captions/` (the Hetzner
workflow does this; here it is a manual `rsync`), then `redeploy.sh`. It is capped at 2 of the
4 vCPUs (`CAPTIONS_CPUS`) at low priority and pauses itself above 95 % host CPU, but on a c-4
that already carries the SFU and an edge composite the live `small` model (~1.5–2 cores for 1–2
speakers) is the first thing to load-test; `CAPTIONS_MODEL=base` halves it. Memory: up to 4 GB
(`CAPTIONS_MEMORY`) of the 8. Sizing in `deploy/captions/README.md`.

## Cloud recording of edge webinars (optional, off)

This box has room for one compositor, so a recording that needs a second (the pre-mix-recorder
behaviour) is refused with `recording_no_capacity`. The mix recorder records the edge mix that
is already running instead: no second Chrome, the audience's stream untouched. To enable it,
put the same 32+ character secret in the API's Cloud Run env as `MIXREC_SECRET` and in
`/opt/livekit/.env` here as `MIXREC_SECRET` (plus `MIXREC_API_URL` if the API is not
`https://webinarliv.com`), then `redeploy.sh` (or push: the workflow syncs `mixrec/` with the rest
of `deploy/livekit-hetzner/`). The API finds it at this box's live origin with `/live` replaced
by `/mixrec`, i.e. `https://<reserved-ip>.sslip.io/mixrec`, or the `do-blr` project's
`mixRecorderUrl`. The API also needs `RECORDINGS_BACKEND=s3` (R2): the recorder uploads through
a URL the API signs, so no bucket credentials live here. Recordings wait as fMP4 segments under
`/opt/livekit/recordings/` until they are uploaded (~0.8 GB an hour of mix). How it works and the
fallbacks: `deploy/livekit-hetzner/README.md`, "Recording from the mix".

## When to grow (not needed yet)

Decided 2026-10-22: one c-4 SFU here, the API stays on Cloud Run. Revisit when usage or the
alerts say so.

**A second video server (or a c-8).** One 4-vCPU box carries the SFU plus, in this test setup,
the edge composite (~1–1.5 cores per edge webinar, measured). Twenty coaches running 20–30
meetings a month each could put 6–8 rooms on at once in the evening, a couple of them 50 people,
which is more than one c-4 does comfortably. One box is also one failure: a crash or reboot drops
every live room on it. Options: resize to **c-8** ($168/month, same capacity as two c-4s, no
redundancy), or a **second c-4** registered as its own `LIVEKIT_PROJECTS` entry (redundancy:
half the rooms on each, new rooms go to the healthy one). Trigger: overlapping evening sessions
from paying coaches, or the CPU alert firing.

**The API on DigitalOcean.** Cloud Run is cheaper today (~$9–13/month, 148 instance-hours in the
30 days to 2026-10-22) because it scales to zero. It flips with edge viewers: each holds the event
stream open for the whole webinar, so an edge webinar keeps ceil(viewers / 500) instances billed
for its length — ~$35–45/month at twenty coaches, against a fixed $12–24 for an API droplet with
no request timeout on those streams. Other reasons: one provider, the API beside the SFUs in
Bangalore. Trigger: the Cloud Run bill passing ~$25–30/month, or its limits getting in the way.
It may never be worth it.

## Removing it

Unassign any host from `do-blr` (or set `"disabled": true` on the entry and redeploy the API),
then `doctl compute droplet delete sfu-blr-1`, `doctl compute reserved-ip delete 152.42.156.192`
(an unattached reserved IP bills $5/month) and `doctl compute firewall delete <id>`.
