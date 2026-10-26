# DigitalOcean (Bangalore) — test video server

A third LiveKit SFU, in DigitalOcean's Bangalore region, running alongside Hetzner (`default`)
and Mumbai GCP (`india`) so meetings and edge webinars (the only webinar delivery here, see
below) can be tried on DigitalOcean before
anything moves. Why DigitalOcean: meetings make SFU egress the main cost, and droplets include
pooled transfer (then ~$0.01/GiB) where GCP charges ~$0.12/GB. Nothing else has moved: the API
is still on Cloud Run, the database on Supabase, recordings on R2, the edge CDN on Bunny.

| Item | Value |
|------|--------|
| Droplet | `sfu-blr-1` · **c-4** (4 dedicated vCPU / 8 GB, 5 TB transfer) · `blr1` · Ubuntu 24.04 · **created on demand** (below) |
| Cost | $0.125/hour while it exists ($84/month if it never went away; a powered-off droplet bills too, so it is deleted, not stopped) |
| Image | newest snapshot tagged `webinar-sfu-image` (`.github/workflows/sfu-snapshot.yml`) |
| Data volume | `sfu-data`, 25 GiB ext4, mounted at `/mnt/sfu-data` (keys, `.env`, certificates, mix-recording staging) |
| Reserved IP | `152.42.156.192` (survives every droplet; free while assigned, $5/month unassigned) |
| Ops box | `ops-blr-1`, s-1vcpu-1gb, runs the one-minute API tick (`deploy/ops-box/README.md`) |
| Domain | `152.42.156.192.sslip.io` (TLS via Caddy) |
| Firewall | `sfu-media`, applied by tag `webinar-sfu`: 22, 80, 443, 7881/tcp, 3478/tcp+udp, 50000–60000/udp |
| Project | DigitalOcean project `webinar-liv-prod` |
| Host path | `/opt/livekit` (the `deploy/livekit-hetzner` stack, egress on the box) |
| LiveKit project id | **`do-blr`**, label "Bangalore (DigitalOcean test)" |

## On demand (since 2026-10-23)

The box no longer runs around the clock. The API (`api/internal/api/sfu_box.go`) creates the
droplet when a session on `do-blr` needs it and deletes it after a quiet spell. What has to
survive a droplet is on the `sfu-data` volume, and the reserved IP moves to each new droplet, so
every droplet is the same server: same keys (`LIVEKIT_PROJECTS` unchanged), same certificates,
same address. There is **no fallback** to another video server: a session on `do-blr` waits for
this box.

**Who steps it.** The API's one-minute tick (`POST /api/internal/tick`), called by the ops box
(`deploy/ops-box`), runs one step of the box's state machine; a join that finds the box down
runs a step itself, so a droplet is created at once rather than at the next tick. The step takes
a row lease in `sfu_box_state`, so two ticks never create two droplets; a create whose answer
was lost is found by the droplet's `webinar-sfu-ondemand` tag and adopted, not repeated.

**Wanted** (`desired = up`) when any of these holds, else after `SFU_BOX_IDLE_GRACE`:

- a session on `do-blr` is live (or a simulive has its doors open);
- one is scheduled to start within `SFU_BOX_WARM_LEAD` (15 min), or up to 30 min late;
- one ended and its transcript is still being made on the box (`finalizing`, as the deploy guard);
- a recording on it is still recording or processing (uploads from the box);
- a join, a Start or an admin's instant session asked for it in the last 10 minutes;
- LiveKit reports people in a room or an egress running on it;
- or less than `SFU_BOX_IDLE_GRACE` (40 min) since the last of these;
- or `SFU_BOX_ALWAYS_ON=true`.

**States** (`actual`, Admin API `GET /api/admin/sfu-box`, and `boxes` in `/api/internal/live-status`):

| State | Meaning | Next |
|---|---|---|
| `down` | no droplet | `creating` when wanted (after the backoff, if the last attempt failed) |
| `creating` | droplet made, not active yet | `booting` once active and the reserved IP is assigned |
| `booting` | running `sfu-boot.sh` | `ready` when LiveKit answers on https://152.42.156.192.sslip.io/, the HLS origin answers and TURN on :443 has a valid certificate for turn.152.42.156.192.sslip.io (needs `TURN_TLS_443=true` in the box .env, as today; set `SFU_BOX_TURN_HOST=-` to skip the TURN check if it is ever turned off) |
| `ready` | serving | `draining`/`deleting` when no longer wanted |
| `draining` | not wanted, but something is still running | `deleting` once nothing is; back to `ready` if wanted |
| `deleting` | delete sent | `down` once DigitalOcean says it is gone (the IP moves to `SFU_BOX_PARK_DROPLET`, if set) |
| `failed` | `SFU_BOX_MAX_FAILURES` (3) create or boot failures in a row | still retried (backoff 30 s → 5 min); `down` once nothing wants it |

**Never deleted** while a session is live, starting soon, finalizing, recording or uploading, or
while LiveKit has participants or egress; LiveKit not answering counts as busy unless the box
also fails its health check. A droplet not ready `SFU_BOX_BOOT_TIMEOUT` (12 min) after create is
deleted and counted as a failure.

**Timings.** Create to ready is typically 2–4 minutes (droplet ~1 min, boot script and
`redeploy.sh` 1–2 min with the images in the snapshot). The warm lead covers that for scheduled sessions. Hosts, panelists, attendees and edge
viewers who arrive while it is starting see **"Starting servers… (about 2 minutes)"** and go in
by themselves (`web/lib/video-server.ts`; the screens re-ask `POST /join`, which answers 503
`sfu_starting`).

**Failures.** Each failed create (DigitalOcean error, no snapshot, volume still attached…) or
boot timeout is retried with backoff. At `SFU_BOX_MAX_FAILURES`, or when a session's start time
passes and the box is not ready, admins get one alert per incident: email (`OPS_ALERT_EMAILS`, else
every admin), the bell, and a Web Push (`ops_alert`). Joins then answer 503 `sfu_failed`: hosts
see "The video server couldn't start" with **Try again** (`POST /api/host/webinars/{slug}/server/retry`
clears the backoff and steps at once); attendees keep waiting. The retries carry on.

**Instant sessions** ("Start a meeting", the Instant webinar card) are an admin's per-host switch,
**Instant meetings/webinars (warm-up)** (Admin → Accounts → Features, key `instant_webinar`),
off for everyone else since migrations/0152. Creating one starts the box at once; the room waits
on the "Starting servers…" screen.

**Deploys.** "Deploy LiveKit (DigitalOcean)" reads the box's state from `live-status`: **down**,
deleting or failed → it skips (nothing to deploy to; the next droplet syncs `deploy/livekit-hetzner`
from `main` at boot, `sfu-boot.sh`); creating or booting → it waits for
ready, then deploys as before, behind the same deploy guard. The SSH host key changes with every
droplet (the workflow scans it each run); the deploy key comes from
`/mnt/sfu-data/ssh/authorized_keys` on the volume. A successful deploy rebuilds the image.

**Costs.** Measured box hours (`sfu_box_runs`) replace "24/7 since the first session" in Admin →
Cost by host (`platform.boxHours`); the Cost calculator's DigitalOcean rates have "Box created on
demand" with an estimate (session hours + 55 min each) or a set number of hours, and show the
measured hours of the last 30 days. Rates are unchanged ($84/month, $0.125/h).

### The pieces

| Where | What |
|---|---|
| `api/internal/api/sfu_box.go` | the state machine, readiness probe, drain check, alerts, endpoints |
| `api/internal/doapi` | the DigitalOcean API calls (`doapitest`: the fake the tests use) |
| `api/internal/store/sfu_box.go`, migrations/0152 | `sfu_box_state` (with the lease), `sfu_box_runs` (hours) |
| `deploy/digitalocean/sfu-boot.sh` | first boot: mount the volume, link `/opt/livekit`, sync deploy files, merge the Grafana Cloud settings from the user data into `.env` (Alloy; `deploy/livekit-hetzner/README.md`, Grafana Cloud), `redeploy.sh` |
| `deploy/digitalocean/build-image.sh` | what the snapshot carries (Docker, ufw, every image; no caption agent) |
| `api/internal/api/captions_box.go`, migrations/0163 | the captions box beside it (see "Captions box") |
| `deploy/digitalocean/build-captions-image.sh`, `captions-boot.sh`, `docker-compose.captions-box.yml` | the captions box's image, first boot and agent |
| `deploy/digitalocean/migrate-to-volume.sh` | one-time: move the running box's state onto the volume |
| `deploy/livekit-hetzner/docker-compose.data.yml` | binds the certificates to the volume (`SFU_DATA_DIR`) |
| `deploy/ops-box/` | the always-on tick droplet |
| `.github/workflows/sfu-snapshot.yml` | builds and tags both images, keeps the newest 2 of each; a push changing `deploy/captions/**` (or the captions box's files) rebuilds the captions image only |

### API settings

Secret `DO_API_TOKEN` (repo secret, used by "Deploy API (Cloud Run)" and the image workflow) and
repo variable `SFU_BOX_PROJECT=do-blr` turn it on (the project without the token is a boot error;
the token alone leaves the box unmanaged). Optional repo variables: `SFU_BOX_ALWAYS_ON`, `SFU_BOX_WARM_LEAD` (15m), `SFU_BOX_IDLE_GRACE`
(40m), `SFU_BOX_SSH_KEYS` (DigitalOcean key ids added to each droplet, e.g. `60277972`),
`SFU_BOX_PARK_DROPLET` (`ops-blr-1`: keep the reserved IP assigned while the box is down, saving
$5/month). The rest (`SFU_BOX_NAME`, `_REGION`, `_SIZE`, `_SNAPSHOT_TAG`, `_VOLUME`,
`_RESERVED_IP`, `_TAGS`, `_BOOT_TIMEOUT`, `_MAX_FAILURES`, `_REF`, `_TURN_HOST`) default to the values
on this page; see `deploy/cloudrun.env.example`. The token needs read and write on droplets,
images/snapshots, tags, block storage (attach) and reserved IPs (a custom-scoped token, or full access).

### One-time setup

Run in this order, after this change is merged and "Deploy LiveKit (DigitalOcean)" has synced the
new files to the box. Steps 1, 3 and 4 create **billable** resources.

1. **The data volume** — *billable: 25 GiB block storage, $2.50/month.*
   ```bash
   doctl --context webinarliv compute volume create sfu-data --region blr1 --size 25GiB \
     --fs-type ext4 --desc "On-demand video server state (deploy/digitalocean/README.md)"
   VOL=$(doctl --context webinarliv compute volume list --format ID,Name --no-header | awk '$2=="sfu-data"{print $1}')
   doctl --context webinarliv compute volume-action attach "$VOL" 611424121 --wait   # sfu-blr-1
   ```
2. **Move the box's state onto it** (when nothing is live: it restarts the stack, ~1 min):
   ```bash
   ssh root@152.42.156.192 'bash -s' < deploy/digitalocean/migrate-to-volume.sh
   ssh root@152.42.156.192 'ls /mnt/sfu-data/livekit/.env.keys /mnt/sfu-data/docker/caddy_data; readlink /opt/livekit'
   curl -fsS https://152.42.156.192.sslip.io/ && echo     # LiveKit OK again
   ```
3. **The ops box** — *billable: s-1vcpu-1gb, $6/month.* Create it and set the tick as in
   `deploy/ops-box/README.md`, check `journalctl -t webinarliv-tick` there is quiet, then stop the
   video server's own cron:
   ```bash
   ssh root@152.42.156.192 'cd /opt/livekit && echo OPS_BOX=true >> .env && ./redeploy.sh'
   ```
4. **The first image** — *billable: ~20 min of a c-4 builder (~$0.04), then ~10 GB of snapshot
   storage at $0.06/GB-month (~$0.60/month each, 2 kept ≈ $1.20/month).* Add the repo secret
   `DO_API_TOKEN`, then Actions → **Video server image (DigitalOcean snapshot)** → Run workflow. Check:
   ```bash
   doctl --context webinarliv compute snapshot list --resource droplet --format ID,Name,CreatedAt,Size
   ```
   (By hand instead, from the running box, which also works since the stack is re-synced at boot:
   `doctl compute droplet-action snapshot 611424121 --snapshot-name webinar-sfu-image-manual --wait`;
   the API finds it by the `webinar-sfu-image-` name prefix when nothing is tagged.)
5. **Hand the box to the API.** Tag the running droplet so the manager adopts it (it is deleted
   the first time it is idle for 40 minutes, and re-created from the image when needed):
   ```bash
   doctl --context webinarliv compute droplet tag 611424121 --tag-name webinar-sfu-ondemand
   ```
   Repo variables `SFU_BOX_PROJECT=do-blr`, `SFU_BOX_SSH_KEYS=60277972`,
   `SFU_BOX_PARK_DROPLET=ops-blr-1`, then Actions → **Deploy API (Cloud Run)**.
6. **Check** (an admin session): `GET /api/admin/sfu-box` shows `actual: ready`, then after the grace
   `deleting` → `down`. Schedule a test session 15 minutes out on a host assigned to `do-blr` and
   watch it come back (`doctl compute droplet list --tag-name webinar-sfu-ondemand`).

Idle baseline after this: ops box $6 + volume $2.50 + snapshots ~$1.20 (+ $5 if the reserved IP is
not parked) ≈ **$10–15/month**, plus **$0.125 per box hour** (e.g. 100 h a month = $12.50),
against $84/month always on.

### Rollback

- **Keep the box up** (the quick one): repo variable `SFU_BOX_ALWAYS_ON=true`, then "Deploy API
  (Cloud Run)". The box is created if it is down and never deleted; everything else stays.
- **Stop managing it**: delete the `SFU_BOX_PROJECT` variable and redeploy the API. Whatever droplet
  exists keeps running as an ordinary always-on box (nothing deletes it); a down box stays down
  until you create one by hand from the image:
  ```bash
  doctl --context webinarliv compute droplet create sfu-blr-1 --region blr1 --size c-4 \
    --image <snapshot id> --volumes <sfu-data id> --tag-names webinar-sfu --ssh-keys 60277972 \
    --user-data-file <(printf '#!/bin/bash\nexec /usr/local/sbin/webinarliv-sfu-boot.sh >>/var/log/webinarliv-boot.log 2>&1\n') --wait
  doctl --context webinarliv compute reserved-ip-action assign 152.42.156.192 <droplet id>
  ```
  If the ops box is retired too, remove `OPS_BOX=true` from the box's `/opt/livekit/.env` and
  `redeploy.sh` so it runs the tick again.

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
```

Keys are in `/opt/livekit/.env.keys` on the box (not in git). `docker compose ps` there needs
`--env-file .env --env-file .env.keys`.

## Registration

Appended to the `LIVEKIT_PROJECTS` GitHub secret, after `default` and `india`. Since the Hetzner
sunset (2026-10-24, `api/internal/api/sfu_retired.go`) new rooms go here whatever the order:
`SFU_BOX_PROJECT` is put first, and a Hetzner project (`default`) takes no new rooms while any
other project does. An admin can still assign a host to `india` (Admin → Accounts → Video server):

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
real audiences: change **this** value to the pull zone (`https://<zone>.b-cdn.net/live`). A
project's `edgePlaybackBase` wins over the API's `EDGE_PLAYBACK_BASE`, so setting only the env var
changes nothing. Until then every viewer is on the box: the 2026-10-24 load test ("via the CDN
playback URL") was in fact all origin, ~1 % of a core and ~1.2-1.4 Mbit/s of the box per viewer, the
4 vCPUs full at ~300-500 viewers. Pull zone settings: origin this box's `https://<ip>.sslip.io`,
request coalescing on for segments, origin `Cache-Control` respected, error responses not
cached. Then re-run **Deploy API (Cloud Run)**. See [ADDING-AN-SFU.md](../../docs/ADDING-AN-SFU.md).

**Plain HLS since 2026-10-25.** The box used to serve LL-HLS (250-500ms parts, blocking playlist
reloads), and through Bunny those reloads failed under a real audience: request coalescing tied
every viewer waiting for the next part to one origin request, and those shared requests got
stuck. In Bunny's log for `video1_stream.m3u8?_HLS_msn=1585&_HLS_part=0`, 89 viewers at the
Singapore edge waited until they gave up (`499`) while this box was healthy, and the same at the
Mumbai edges. MediaMTX now writes plain fMP4 HLS (`hlsVariant: fmp4`, 2s segments), about one
request a second per viewer and all of it cacheable, ~6s behind live. `HLS_PART_DURATION` in an
old box's `.env` is ignored.

**Delivery by where the viewer is.** With `EDGE_NEAR_COUNTRIES` set on the API (e.g. `IN`), a
viewer in one of those countries, or of unknown country, plays this box directly
(`broadcastHlsBase`), and everyone else plays the pull zone (`edgePlaybackBase`); each gets the
other as `fallbackPlaybackUrl`. Unset, everyone plays `edgePlaybackBase` as before. Both are
the same plain HLS from the same `/live/*` path, so nothing on the box differs by path.

CI: **Deploy LiveKit (DigitalOcean)** (`.github/workflows/livekit-do-deploy.yml`) syncs
`deploy/livekit-hetzner/` here and runs `redeploy.sh` on every push to main that changes it, like
the Hetzner workflow. A `deploy/captions/` change does not deploy here (captions run only on the
captions box, below). It needs the repo secrets `DO_SSH_HOST`
(`root@152.42.156.192`) and `DO_SSH_PRIVATE_KEY` (a deploy key in the box's
`authorized_keys`, and in `/mnt/sfu-data/ssh/authorized_keys` so every new droplet has it);
without them it skips with a notice. While the box is down it skips too (see "On demand").

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

## Server captions: only on the captions box

The video box never runs the caption agent: its image, boot and deploy carry none (removed
24 Oct 2026, after the agent's 0.66 cores beside the edge mix's 1.84 stalled the audience). Server
captions run only on the separate captions box (next section). With `CAPTIONS_BOX_ENABLED` off
there are no server captions for this box's rooms: the API dispatches no agent, the host's
captions control shows **"Captions: on this device (server captions unavailable)"** and each
speaker's browser makes the captions (Whisper tiny.en, `web/lib/local-captions.ts`). No
after-session transcript is made for the AI recap then either.

Boxes and volumes from before: the next `redeploy.sh` (a deploy, or the next droplet's boot)
removes any caption container and its image, `captions.env`, `/opt/livekit/captions/`,
`docker-compose.captions.yml`, and the old `captions_models` (~2.7 GB) and `captions_spool`
directories on the volume. `CAPTIONS_*` lines left in `/opt/livekit/.env` are ignored, and
`sfu-boot.sh` drops `CAPTIONS_REMOTE`. `CAPTIONS_ON_VIDEO_BOX` (a short-lived opt-back-in) is gone too.

## Captions box (optional, off until `CAPTIONS_BOX_ENABLED=true`)

On 24 Oct 2026 the c-4 ran at 70–91 % during a live session (egress/mix 1.84 cores, caption agent
0.66, LiveKit 0.26) and the audience stalled. The captions box moves the caption agent onto a
small droplet of its own, **one per video box, shared by every room on it**, created by the API in
the same step as the video droplet and deleted in the step that deletes it
(`api/internal/api/captions_box.go`). The video box runs no caption agent at all, so its CPU is
LiveKit's and the mix's.

**How it fits.**

- *State.* `captions_box_state` (migrations/0163), one row per video box project, written only
  under that project's `sfu_box_state` lease: `down → creating → ready → deleting → down`. A
  second video box would get a captions box of its own on its own row.
- *Never in the video box's way.* The captions step runs after the video box's step has been
  saved. A failed create (no snapshot, a DigitalOcean error) or a droplet not active within
  `CAPTIONS_BOX_BOOT_TIMEOUT` (10 min) is deleted and retried with the same backoff (30 s → 5 min).
  After `SFU_BOX_MAX_FAILURES` attempts it sends one ops email. Video carries on: rooms caption
  on each speaker's device (the existing fallback), and the host's captions show that source.
- *No orphaned billing.* Every captions droplet is tagged `webinar-captions-ondemand`. A wanted
  box that is down adopts a tagged droplet instead of creating a second one (a create whose
  answer was lost), and deletes any extras. `deleting` lasts until the tag lists nothing. A box
  that is down and not wanted (the switch was turned off mid-run, say) checks the tag every
  5 minutes and deletes anything it finds. Hours go in `sfu_box_runs` as project
  `do-blr:captions`; the cost report's video box hours are unchanged.
- *The agent.* The captions droplet comes from the newest `webinar-captions-image` snapshot. The
  image has Docker, a ufw that lets in SSH only, and the agent's image with **base.en and
  large-v3-turbo baked in**, so a new box downloads no models. Its user data writes
  `/etc/webinarliv/captions.env` (root, 0600; and `/etc/webinarliv/grafana.env` when Grafana
  Cloud is configured, see below): the video box's LiveKit URL
  (`LIVEKIT_PROJECTS` for `do-blr`, i.e. the reserved IP's sslip.io name, through Caddy; or
  `CAPTIONS_BOX_LIVEKIT_URL`), its API key and secret, `CAPTIONS_SECRET` and the size settings.
  `captions-boot.sh` then syncs `deploy/captions` from `SFU_BOX_REF`, rebuilds the image (a cache
  hit unless the agent changed) and starts `docker-compose.captions-box.yml`. The box has no
  volume, so the secrets travel in user data. They are readable from inside the droplet and by
  holders of the DO token, the same exposure as the video box's Grafana token. They are never
  logged. "Deploy LiveKit (DigitalOcean)" does not touch the captions box, and an agent change
  does not touch the video box: a push changing `deploy/captions/**` rebuilds the
  `webinar-captions-image` snapshot (sfu-snapshot.yml), and reaches a running captions box the
  next time it is created.
- *Dispatch.* The agent connects out to LiveKit and registers as a worker under
  `CAPTIONS_AGENT_NAME`; the API's dispatch is unchanged. A room dispatched before that worker was
  up (or while it was full) has a dispatch with no job. While the box is ready, each tick
  re-creates those dispatches for live rooms whose agent has not reported live
  (`lk.Client.RedispatchIdle`). It never touches a dispatch that has a pending or running job, so
  a room never gets two agents. Captions therefore start up to a minute after the box is ready.
- *The video box.* Nothing captions-related: its user data no longer carries
  `SFU_CAPTIONS_REMOTE` (`sfu-boot.sh` ignores it from an older API), and `redeploy.sh` never
  starts a caption container. LiveKit's agent dispatch needs no setting on the box: the remote
  worker registers over the network.

**Size and capacity.** Default `CAPTIONS_BOX_SIZE=s-2vcpu-4gb` (2 shared vCPUs, 4 GB). The agent
takes up to `CAPTIONS_BOX_MAX_ROOMS` rooms at once (default 2 per vCPU, so 4). It runs each room
in its own process (~0.3 GB with base.en) plus one prewarmed, and the after-session
`large-v3-turbo` pass (~1.7 GB) runs only when no room is live. A room beyond the limit is not
picked up and keeps on-device captions; the re-dispatch above takes it in when a slot frees.

base.en is ≈ 0.3–0.4 of a core per actively transcribed speaker, at most 2 speakers per room, and
~0 in silence (energy gate). Interim captions (`CAPTIONS_PARTIALS`, on) add up to ~0.3 while the
main speaker talks. These are estimates from the small.en measurement (0.66 cores on 24 Oct) and
the model sizes, not a load test:

| Captions box | $/hour | Rooms, typical (one person talking at a time) | Rooms, worst case (two talking continuously) | Default `MAX_ROOMS` |
|---|---|---|---|---|
| `s-2vcpu-4gb` (default) | $0.036 | 4–5 | 2–3 | 4 |
| `c-2` (dedicated vCPUs, 4 GB) | $0.0625 | 4–5 | 2–3 | 4 |
| `c-4` | $0.125 | 8–10 | 5–6 | 8 |

Above ~85 % host CPU the agent's guard steps down (one speaker per room, stale windows skipped),
and above 95 % it pauses (rooms fall back to on-device). **The video box is the tighter limit**:
an edge webinar's mix costs ≈ 0.7–1.8 cores on the c-4, so about 2 edge webinars at once fit
beside LiveKit. The default captions box already covers more rooms than the video box can hold.
Choose `c-2` if shared vCPUs show steal time under load.

**Cost.** It runs exactly when the video box does: c-4 $0.125/h + s-2vcpu-4gb $0.036/h = $0.161/h
(+29 %). For a 1-hour session (box up ~2 h with the warm lead and idle grace) that is +$0.07. The
`webinar-captions-image` snapshots (~7 GB each, newest 2 kept) cost ~$0.85/month, and each image
build ~$0.02 (a c-2 builder for ~15 min). Snapshots are built on a c-2 because its 25 GB disk fits
every size above.

**To turn it on** (manual steps; the API creates and deletes nothing until step 4):

1. Merge the base.en PR first (it adds the baked-model seed to `deploy/captions/Dockerfile` and
   `webcaptions/download.py`), then this one.
2. Run **Actions → "Video server image (DigitalOcean snapshot)" → Run workflow**. It builds
   both `webinar-sfu-image` and `webinar-captions-image`. Check the captions snapshot exists:
   `doctl compute snapshot list | grep webinar-captions-image`.
3. Create the firewall (inbound SSH only; the agent only connects out to LiveKit on 443/7881 and
   UDP 50000–60000, to the API on 443, and to GitHub at boot):

   ```bash
   doctl compute firewall create --name captions-box --tag-names webinar-captions \
     --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0" \
     --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
   ```

   Narrow the SSH source to your own IP if you like, or drop the inbound rule entirely (the box
   needs no inbound at all). Do **not** give it the `webinar-sfu` tag: that is the media firewall
   and the video box's alerts. The API refuses `CAPTIONS_BOX_TAGS` that include it.
4. Set repository variable `CAPTIONS_BOX_ENABLED=true` (optionally `CAPTIONS_BOX_SIZE`,
   `CAPTIONS_BOX_MAX_ROOMS`, `CAPTIONS_BOX_CPUS`, `CAPTIONS_BOX_IMAGE`, `CAPTIONS_BOX_MODEL`) and
   redeploy the API ("Deploy API (Cloud Run)"). `CAPTIONS_SECRET` and `DO_API_TOKEN` are already
   there; the token needs nothing new.

**Check it** during a session: `doctl compute droplet list --tag-name webinar-captions-ondemand`;
on the box, `docker compose -p captions logs -f` (the worker registers, then "job" per room) and
`/var/log/webinarliv-captions-boot.log`. The API logs `captions box: state` transitions and
`dispatch re-sent to the captions worker`.

**Grafana Cloud.** With the video box's Grafana Cloud settings configured on the API (all five
`GRAFANA_CLOUD_*`, `config.BoxGrafana`), the captions box reports like the video box:

- The API's user data writes them to `/etc/webinarliv/grafana.env` (root, 0600; a separate file,
  so the token is never in the agent's environment). Four of five, or a value that is not plain,
  and nothing is written. The token is never logged (`captions_box_internal_test.go`).
- `captions-boot.sh` checks the file the way `sfu-boot.sh` does (exactly the five lines), writes
  `/opt/captions-box/alloy.env` with `ALLOY_BOX=$(hostname -s)` (the droplet name,
  `captions-blr-1`), and starts Grafana Alloy in the same compose project
  (`docker compose -p captions -f docker-compose.yml -f docker-compose.alloy.yml`). Without the
  file, no Alloy (and `--remove-orphans` removes one from an earlier run).
- Alloy is the video box's `deploy/livekit-hetzner/docker-compose.alloy.yml` (same pinned image,
  baked into the `webinar-captions-image` snapshot; the containerd socket mount; 0.5 CPU,
  512 MB cap) with `deploy/digitalocean/alloy/captions.alloy`: host metrics (CPU incl. `nice`,
  where the niced agent's CPU shows; memory, network, disk, load, pressure), cAdvisor per
  container (`service="captions"` and `"alloy"`), the agent's worker metrics, and every
  container's log to Loki. Same keep-lists as the video box, no LiveKit or MediaMTX scrape.
- Labels: `box="captions-blr-1"`, `role="captions"` on every series and log stream. The video
  box's now carry `role="video"` too.
- The agent's metrics: livekit-agents' own Prometheus endpoint (`CAPTIONS_METRICS_PORT=8092`, set
  in `docker-compose.captions-box.yml`; ufw and the firewall let nothing in):
  `lk_agents_active_job_count` (rooms held: one job per room), `lk_agents_worker_load` (rooms
  over `CAPTIONS_BOX_MAX_ROOMS`), `lk_agents_child_process_count`, and the main process's CPU and
  memory. Per-room latency (transcribe lag, decode ms, queue) is not exported: it is measured in
  each room's child process and logged once a minute per room (`captions latency ...` in Loki),
  and per-room series would cost series for nothing a log query cannot answer.
- Budget: ~120 active series while a captions box runs (docs/observability.md, "Series budget").

Check it on the box: `docker compose -p captions logs alloy` and, in Grafana,
`up{role="captions"}` (three targets: host, containers, agent).

**Turning it off.** Unset `CAPTIONS_BOX_ENABLED` (or set it to `false`) and redeploy the API. The
captions droplet is deleted at the next tick. There is no fallback to an agent on the video box:
rooms caption on each speaker's device and the host sees "server captions unavailable".

## Webinars here are always edge

Every webinar (one-off, instant or a recurring series) on this box is **edge**: the stage on
WebRTC, the audience on LL-HLS through Bunny. The schedule form offers no Standard / WebRTC
choice for it and the API stores edge whatever a save sends; there is no account switch (the
"Edge delivery (beta)" setting went with Hetzner). The same holds for the Mumbai GCP project. The
provider comes from the project's `"provider": "do"` (or the id/label: `do-blr` reads as DO). A
webinar not opened yet is judged by where it will go: the host's assigned project (Admin →
Accounts → Video server) when it is taking rooms and not Hetzner, else this box. At boot the API
moves draft and scheduled webinars still pinned to Hetzner here, then moves draft and scheduled
webinars headed here onto edge; live and ended ones, meetings,
simulive and Zoom are left alone. Meetings stay on WebRTC. See `docs/edge-delivery.md`.

Capacity: each concurrent webinar runs one composite mix on this c-4 (~1–1.5 cores), so two or
three at once beside the SFU is the comfortable ceiling. The audience is ~2.5 s behind the stage
(LL-HLS), which shows in Q&A and "raise your hand" timing.

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

## TURN over TLS on 443 (optional, off)

For participants on networks that let out only TCP 443 (corporate, hotel, some VPNs), where
WebRTC UDP, TCP 7881 and TURN 3478 are all blocked. Caddy keeps :443 and splits it by the TLS
SNI (`Caddyfile.turn443`, Caddy rebuilt with the `caddy-l4` plugin): `turn.152.42.156.192.sslip.io`
is TLS-terminated by Caddy and passed to LiveKit's TURN on `127.0.0.1:5349`; every other name goes
to the normal Caddy sites. LiveKit then hands every client
`turns:turn.152.42.156.192.sslip.io:443?transport=tcp`. No new ports, firewall rules or cost:
443/tcp is already open in `sfu-media` and ufw, and the reserved IP is unchanged. How it works:
`deploy/livekit-hetzner/README.md`, "TURN over TLS on 443".

To enable (when the box is idle: Caddy and LiveKit restart, which drops live rooms for a few seconds):

```bash
ssh root@152.42.156.192 'cd /opt/livekit && echo TURN_TLS_443=true >> .env && ./redeploy.sh'
# First run builds the Caddy image (~2-3 min). It should end with
#   TURN over TLS: turns:turn.152.42.156.192.sslip.io:443?transport=tcp (certificate verifies)
```

Check from your laptop:

```bash
dig +short turn.152.42.156.192.sslip.io                      # 152.42.156.192
openssl s_client -connect 152.42.156.192:443 -servername turn.152.42.156.192.sslip.io \
  -verify_hostname turn.152.42.156.192.sslip.io </dev/null 2>&1 | grep -E 'subject=|Verify return'
#   subject=CN=turn.152.42.156.192.sslip.io, Verify return code: 0 (ok)
curl -fsS https://152.42.156.192.sslip.io/ ; echo                # LiveKit "OK": the normal site still works
ssh root@152.42.156.192 "grep -A8 '^turn:' /opt/livekit/livekit.yaml"   # tls_port 5349, external_tls true
```

Browser test with only TCP 443 open (macOS, pf; blocks UDP and the other TCP ports to the box):

```bash
printf 'block drop out quick proto udp to 152.42.156.192\nblock drop out quick proto tcp to 152.42.156.192 port != 443\n' \
  | sudo pfctl -ef -
```

Join a meeting on this server in Chrome and open `chrome://webrtc-internals`: the connection
should succeed, and the selected candidate pair's local candidate is `candidateType: relay`
with `relayProtocol: tls` (the ICE server `turns:turn.152.42.156.192.sslip.io:443`). Without
`TURN_TLS_443` the same test fails to connect. Restore the firewall afterwards:
`sudo pfctl -f /etc/pf.conf && sudo pfctl -d`.

To turn it off: delete the `TURN_TLS_443` line from `/opt/livekit/.env` and run `redeploy.sh`
(back to the stock Caddy image and the previous `livekit.yaml`).

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

Unassign any host from `do-blr` (or set `"disabled": true` on the entry), delete the
`SFU_BOX_PROJECT` variable and redeploy the API, then `doctl compute droplet delete sfu-blr-1`,
`doctl compute reserved-ip delete 152.42.156.192` (an unattached reserved IP bills $5/month),
`doctl compute volume delete <sfu-data id>` (after copying `livekit/.env.keys` off it if the keys
are still wanted), the `webinar-sfu-image-*` snapshots and `doctl compute firewall delete <id>`.
The ops box (`ops-blr-1`) can stay: it ticks the API whatever the video servers.
