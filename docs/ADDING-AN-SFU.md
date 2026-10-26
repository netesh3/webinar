# Adding a second video server (SFU)

Production video runs on `do-blr`, the on-demand DigitalOcean box in Bangalore
([deploy/digitalocean/README.md](../deploy/digitalocean/README.md), `SFU_BOX_PROJECT`).
The Hetzner SFU (project **`default`**, from the legacy `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET` secrets) was deleted on 2026-10-26, and the GCP test project `india`
(Mumbai) is disabled with its VMs deleted ([HETZNER-SUNSET.md](HETZNER-SUNSET.md)).

The API supports several self-hosted LiveKit projects at once (`LIVEKIT_PROJECTS`), and an
admin can send one host's new webinars to a chosen project from the admin Accounts list
("Video server").

## How routing works

- A webinar's room is pinned to a project on its first join (`webinars.sfu_project`). Every
  participant of that webinar then uses that project. **A pinned room never moves.**
- The project for that first pin is the **host's assigned project** (`users.sfu_project`, set by
  an admin) when it is configured and enabled; otherwise `SFU_BOX_PROJECT` when set; otherwise
  the first enabled project in `LIVEKIT_PROJECTS` order.
- **Hetzner takes no new rooms** (`api/internal/api/sfu_retired.go`): a project whose provider is
  `hetzner` is left out of that order while any other project is enabled, and cannot be
  assigned. The provider is the entry's `"provider"` (`do`, `gcp`, `hetzner`), else guessed from
  its id/label, where **anything unrecognised reads as Hetzner** — so always give a new entry
  its `"provider"`. Draft and scheduled webinars still pinned to Hetzner move at boot or at their
  next join (not while LiveKit reports people in the old room); live and ended ones stay.
- A disabled project takes no new rooms and is **retired** like Hetzner (2026-10-26): draft and
  scheduled webinars pinned to it move to the box at boot or at their next join; a session live
  on it keeps it until it ends. If a host's assigned project is disabled or removed, their new
  webinars quietly use the default order.
- A live webinar is never moved, even if its project is removed (it gets a clear 503). A
  scheduled one whose project is removed is re-pinned on its next join.

## `LIVEKIT_PROJECTS`

Ids are permanent (they are in the database). Order decides where unassigned hosts go when
`SFU_BOX_PROJECT` is not set. The template below is the general shape: the on-demand box plus a
second server, each stating its `"provider"`.

<!-- LIVEKIT_PROJECTS template: begin -->
```json
[
  {
    "id": "do-blr",
    "label": "Bangalore (DigitalOcean)",
    "provider": "do",
    "url": "wss://203.0.113.10.sslip.io",
    "key": "<box API key>",
    "secret": "<box API secret>",
    "broadcastHlsBase": "https://203.0.113.10.sslip.io/live",
    "edgePlaybackBase": "https://example-zone.b-cdn.net/live"
  },
  {
    "id": "edge2",
    "provider": "do",
    "label": "Second server",
    "url": "wss://sfu2.webinarliv.com",
    "key": "<second server API key>",
    "secret": "<second server API secret>",
    "broadcastHlsBase": "https://live2.webinarliv.com/live"
  }
]
```
<!-- LIVEKIT_PROJECTS template: end -->

- Every entry states its own `url`, `key` and `secret`. (An entry with the id `default` may
  still leave them out and take them from the legacy `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
  `LIVEKIT_API_SECRET`; production no longer has one.) Ids are stored in the database: add and
  disable freely, **never rename**. To take a server out, mark it `"disabled": true` first
  (what is pinned to it moves), and remove the entry once nothing live is on it.
- Set it as the `LIVEKIT_PROJECTS` GitHub secret and re-run **Deploy API (Cloud Run)**. While it
  is set the legacy trio is ignored; deleting it falls back to the legacy trio.
- `api/internal/config` test `TestTheAddingAnSFUTemplateLoads` parses this exact block.

## Setting up the second box

The stack in `deploy/livekit-box/` is provider-agnostic (Ubuntu 22.04/24.04, root SSH, a
public IPv4 the box itself sees, ≥4 vCPU / 8 GB). Inbound ports: 22, 80, 443, 7881/tcp,
3478/udp+tcp, 50000–60000/udp.

1. Create the server and a DNS-only A record for its hostname (e.g. `sfu2.webinarliv.com`).
2. Install once as root: copy `deploy/livekit-box/` to `/opt/livekit` and run
   `DOMAIN=sfu2.webinarliv.com ACME_EMAIL=… bash /opt/livekit/install.sh`. Read the generated
   key/secret from `/opt/livekit/.env.keys` for `LIVEKIT_PROJECTS`.
   - If the domain is not `<ip>.sslip.io`, pin the advertised IP: after install, set
     `rtc.node_ip: <public IPv4>` and `use_external_ip: false` in `/opt/livekit/livekit.yaml`
     (`redeploy.sh` preserves them), then `docker compose restart livekit`.
3. Live origin for rooms on that box: its Egress pushes to the MediaMTX on the same box, so
   viewers must be sent to *that* box. Caddy serves `/live/*` on the box's own `DOMAIN`.
   - **Edge delivery** for rooms on that box: `EDGE_PLAYBACK_BASE` is one pull zone mirroring
     one origin, so give the project its own `"edgePlaybackBase"` — the box's `/live` (e.g.
     `https://<ip>.sslip.io/live`) or a pull zone of its own. It wins over `EDGE_PLAYBACK_BASE`.
4. Automatic redeploys: the **Deploy LiveKit (DigitalOcean)** workflow only targets the DO box.
   Add a matrix entry (its own SSH secrets) when the second box should be redeployed by CI.

Webhooks need nothing new: the second box posts to the same `/api/webhooks/livekit`, signed
with its own key, and the check accepts any configured project's key
(`TestWebhooksFromEveryProjectVerify`). Recordings need nothing new either: every egress
request carries the B2 bucket and credentials (`RECORDINGS_S3_*`).

## Assigning a host

Admin → Accounts → Customers → the host's row → **Video server**. The select appears when more
than one project is configured; "Default" clears the assignment. API:
`PATCH /api/admin/users/{id}/sfu` with `{"project":"edge2"}` (or `""`); the list is
`GET /api/admin/sfu-projects` (ids, labels, enabled — never keys, secrets or URLs).
Only enabled projects can be assigned, and only the host's **new** webinars move.

## Checking the effect

```sh
gcloud logging read \
  'resource.type="cloud_run_revision" AND jsonPayload.event="quality_sample" AND jsonPayload.metrics.direction="outbound" AND jsonPayload.metrics.kind="video"' \
  --project selfreminder-rnix --freshness=24h --limit 5000 --format=json \
| python3 -c '
import json, sys, statistics, collections
rows = collections.defaultdict(lambda: {"rtt": [], "bw": 0, "n": 0})
for e in json.load(sys.stdin):
    p = e.get("jsonPayload", {}); m = p.get("metrics", {})
    r = rows[p.get("roomName", "?")]
    if m.get("roundTripTimeMs") is not None: r["rtt"].append(m["roundTripTimeMs"])
    r["n"] += 1; r["bw"] += m.get("qualityLimitationReason") == "bandwidth"
for room, r in sorted(rows.items()):
    med = statistics.median(r["rtt"]) if r["rtt"] else None
    print(room.ljust(40), "median RTT", med, "ms   bandwidth-limited", r["bw"], "/", r["n"])
'
```

The room name is the webinar slug; `select slug, sfu_project from webinars where slug = '…'`
shows which project it ran on.
