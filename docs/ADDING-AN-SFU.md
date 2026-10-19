# Adding a second video server (SFU)

Today production runs one self-hosted LiveKit SFU on Hetzner (fsn1), configured with the
legacy `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` secrets. Every webinar created
so far is pinned to the project id **`default`**. Nothing here is needed until a second server
exists.

The API supports several self-hosted LiveKit projects at once (`LIVEKIT_PROJECTS`), and an
admin can send one host's new webinars to a chosen project from the admin Accounts list
("Video server").

## How routing works

- A webinar's room is pinned to a project on its first join (`webinars.sfu_project`). Every
  participant of that webinar then uses that project. **A pinned room never moves.**
- The project for that first pin is the **host's assigned project** (`users.sfu_project`, set by
  an admin) when it is configured and enabled; otherwise the first enabled project in
  `LIVEKIT_PROJECTS` order.
- A disabled project still serves the webinars already pinned to it; it just takes no new ones.
  If a host's assigned project is disabled or removed, their new webinars quietly use the
  default order.
- A live webinar is never moved, even if its project is removed (it gets a clear 503). A
  scheduled one whose project is removed is re-pinned on its next join.

## `LIVEKIT_PROJECTS`

Keep the current box as `default` (with today's legacy values) so existing webinars keep
working, and add the new project. Order decides where unassigned hosts go: put `default` first
to keep everyone on Hetzner and only send assigned hosts to the new project.

<!-- LIVEKIT_PROJECTS template: begin -->
```json
[
  {
    "id": "default",
    "label": "Hetzner (default)",
    "url": "wss://88.198.141.104.sslip.io",
    "key": "<current LIVEKIT_API_KEY>",
    "secret": "<current LIVEKIT_API_SECRET>"
  },
  {
    "id": "edge2",
    "label": "Second server",
    "url": "wss://sfu2.webinarliv.com",
    "key": "<second server API key>",
    "secret": "<second server API secret>",
    "broadcastHlsBase": "https://live2.webinarliv.com/live"
  }
]
```
<!-- LIVEKIT_PROJECTS template: end -->

- If `LIVEKIT_HTTP_URL` is set today, add it to `default` as
  `"httpUrl"`. Ids are stored in the database: add and disable freely, **never rename**.
- Set it as the `LIVEKIT_PROJECTS` GitHub secret and re-run **Deploy API (Cloud Run)**. While it
  is set the legacy trio is ignored; deleting it falls back to the legacy trio.
- `api/internal/config` test `TestTheAddingAnSFUTemplateLoads` parses this exact block.

## Setting up the second box

The stack in `deploy/livekit-hetzner/` is provider-agnostic (Ubuntu 22.04/24.04, root SSH, a
public IPv4 the box itself sees, ≥4 vCPU / 8 GB). Inbound ports: 22, 80, 443, 7881/tcp,
3478/udp+tcp, 50000–60000/udp, 8189/udp.

1. Create the server and a DNS-only A record for its hostname (e.g. `sfu2.webinarliv.com`).
2. Install once as root: copy `deploy/livekit-hetzner/` to `/opt/livekit` and run
   `DOMAIN=sfu2.webinarliv.com ACME_EMAIL=… bash /opt/livekit/install.sh`. Read the generated
   key/secret from `/opt/livekit/.env.keys` for `LIVEKIT_PROJECTS`.
   - If the domain is not `<ip>.sslip.io`, pin the advertised IP: after install, set
     `rtc.node_ip: <public IPv4>` and `use_external_ip: false` in `/opt/livekit/livekit.yaml`
     (`redeploy.sh` preserves them), then `docker compose restart livekit`.
3. CDN broadcast for rooms on that box: its Egress pushes to the MediaMTX on the same box, so
   viewers must be sent to *that* box. Give it a proxied attendee origin (e.g.
   `live2.webinarliv.com`, via the **Live origin DNS** workflow) and set the project's
   `broadcastHlsBase`. Caddy on the box serves the WHEP path on its own `DOMAIN` too, and the
   `live.webinarliv.com` block in the Caddyfile would need that box's hostname instead.
   - **Edge delivery** for rooms on that box: `EDGE_PLAYBACK_BASE` is one pull zone mirroring
     one origin, so give the project its own `"edgePlaybackBase"` — the box's `/live` (e.g.
     `https://<ip>.sslip.io/live`) or a pull zone of its own. It wins over `EDGE_PLAYBACK_BASE`.
4. Automatic redeploys: the **Deploy LiveKit (Hetzner)** workflow only targets the Hetzner box.
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
