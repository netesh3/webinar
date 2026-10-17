# A second SFU in Bangalore

Why: production telemetry (Cloud Run logs, room `instant-webinar-9650`, 2026-10-17) showed a
host on a 33 Mbps line with **~200 ms RTT** to the only SFU — a Hetzner CX33 in **fsn1,
Falkenstein**. At that distance the browser's bandwidth estimate keeps dipping, the top
screen-share layer switches off, and every viewer falls to a lower layer at once. A box in
Bangalore should bring Indian RTT to roughly 10–40 ms.

What changes: new webinars go to the Bangalore SFU (`blr1`). Webinars already pinned to the
Hetzner box (project id `default`) keep using it until they are over, then Hetzner is retired.
No session is moved while it is live — see "How routing behaves".

---

## 1. You (account and infra) — about 20 minutes

1. **Droplet.** DigitalOcean → Create → Droplet → region **Bangalore (BLR1)**, image
   **Ubuntu 24.04 LTS**, size **Basic, 4 vCPU / 8 GB** (~$48/mo, 5 TB transfer; move to
   CPU-Optimized later if CPU is the limit). Add the deploy SSH public key. Note the IPv4.
2. **DigitalOcean firewall** (Networking → Firewalls, attach to the droplet), inbound:
   | Port | Proto | What |
   |---|---|---|
   | 22 | TCP | SSH (deploy workflow) |
   | 80, 443 | TCP | Caddy (TLS, signalling, WHEP) |
   | 7881 | TCP | LiveKit RTC over TCP |
   | 3478 | UDP + TCP | TURN |
   | 50000–60000 | UDP | LiveKit media |
   | 8189 | UDP | MediaMTX WHEP media (CDN broadcast) |
   The box also enables the same rules in `ufw` on install (`deploy/livekit-hetzner/install.sh`).
3. **DNS (Cloudflare, zone webinarliv.com):**
   - `sfu-in.webinarliv.com` → A → droplet IPv4, **DNS only (grey cloud)**. Caddy gets its own
     certificate and TURN/UDP cannot go through Cloudflare's proxy.
   - `live-in.webinarliv.com` → A → droplet IPv4, **Proxied (orange cloud)** — the attendee
     broadcast origin, same as `live.webinarliv.com` is for Hetzner. You can create it with the
     **Live origin DNS** workflow (Actions → Live origin DNS → hostname `live-in.webinarliv.com`,
     target the droplet IPv4).
4. **GitHub secrets** (Settings → Secrets and variables → Actions):
   | Name | Value |
   |---|---|
   | `SFU_BLR1_SSH_HOST` | `root@<droplet IPv4>` |
   | `SFU_BLR1_SSH_PRIVATE_KEY` | the private key matching step 1 |
   | `SFU_BLR1_LIVEKIT_KEY` | `API` + 16 hex chars, e.g. `APIa1b2c3d4e5f60718` |
   | `SFU_BLR1_LIVEKIT_SECRET` | output of `openssl rand -hex 32` |
   Optional repo **variable** `ACME_EMAIL` (Let's Encrypt contact; default support@webinarliv.com).
5. **Install the box:** Actions → **Deploy LiveKit (Hetzner)** → Run workflow → target `blr1`,
   tick **install**. It syncs the files, runs `install.sh` once with your key/secret, and starts
   LiveKit, Egress, MediaMTX and Caddy. It refuses a box that already has keys.
   Check: `curl -s https://sfu-in.webinarliv.com` answers (LiveKit returns `OK`).
6. **Point the API at it:** set the `LIVEKIT_PROJECTS` secret to the template below, with the
   real values, then re-run **Deploy API (Cloud Run)**. Keep the legacy `LIVEKIT_URL` /
   `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` secrets in place — they are ignored while
   `LIVEKIT_PROJECTS` is set and are the instant fallback (delete `LIVEKIT_PROJECTS` and redeploy).

After that, every later push that changes `deploy/livekit-hetzner/**` redeploys **both** boxes.

---

## 2. `LIVEKIT_PROJECTS` value

`blr1` first and enabled; `default` is the current Hetzner box with the values of today's
legacy secrets, **disabled** — it still serves every webinar already pinned to it, it just
takes no new ones. The id `default` must stay exactly that: it is what the database records for
every webinar created before this change.

<!-- LIVEKIT_PROJECTS template: begin -->
```json
[
  {
    "id": "blr1",
    "url": "wss://sfu-in.webinarliv.com",
    "key": "<SFU_BLR1_LIVEKIT_KEY>",
    "secret": "<SFU_BLR1_LIVEKIT_SECRET>",
    "broadcastHlsBase": "https://live-in.webinarliv.com/live"
  },
  {
    "id": "default",
    "url": "wss://88.198.141.104.sslip.io",
    "key": "<current LIVEKIT_API_KEY>",
    "secret": "<current LIVEKIT_API_SECRET>",
    "disabled": true
  }
]
```
<!-- LIVEKIT_PROJECTS template: end -->

- Replace the `<…>` values. If the legacy `LIVEKIT_URL` secret is not
  `wss://88.198.141.104.sslip.io`, use whatever it is. If `LIVEKIT_HTTP_URL` is set today, add
  it to `default` as `"httpUrl"`.
- `broadcastHlsBase` is why the CDN broadcast keeps working: the broadcast is composited by the
  Egress beside each SFU and pushed to that box's own MediaMTX (`BROADCAST_RTMP_BASE` is
  `rtmp://127.0.0.1:1935/live` on purpose), so a room on `blr1` must be watched from
  `live-in.webinarliv.com`, not from Hetzner's `live.webinarliv.com`. `default` has none and
  keeps using the global `BROADCAST_HLS_BASE`.
- The test `TestTheBangaloreRunbookTemplateLoads` (api/internal/config) parses this exact block,
  so a doc edit that `Load` would reject fails CI.

---

## 3. How routing behaves (already in the code)

From `api/internal/api/sfu.go` / `config/livekit.go`, covered by `api/internal/api/sfu_test.go`:

- **New webinar** → first *enabled* project (`blr1`), pinned in `webinars.sfu_project` on first join.
- **Webinar pinned to `default`** → keeps `default` while it is disabled. Host, audience, mutes,
  chat, recordings all go to the pinned project.
- **Live webinar** → never moved, even if its project disappears from the list (it gets a clear
  503 instead of a split room).
- **Scheduled webinar whose project is removed** → re-pinned to the first enabled project on its
  next join.
- **Failover** → if `blr1` refuses to create a room for a webinar pinned a moment ago, that
  webinar falls over to the next enabled project.

`TestMovingNewSessionsToBangalore` walks this exact migration end to end.

---

## 4. Verify (first week)

RTT and bandwidth-limited share for hosts, per room, last 24 h:

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

Which project a room is on: `select slug, sfu_project from webinars where slug = '<room slug>';`
(the room name is the slug). On 2026-10-17 rooms on `default` showed a median host RTT of
~130–190 ms, and the busiest sessions were bandwidth-limited in a third to half of samples.
Expect `blr1` rooms around 10–40 ms from India with far fewer `bandwidth` samples.

---

## 5. Rollback

Instant, for new rooms: move `default` back to the top of `LIVEKIT_PROJECTS` and set
`"disabled": true` on `blr1` (or delete the `LIVEKIT_PROJECTS` secret to fall back to the legacy
trio), then redeploy the API. Webinars already pinned to `blr1` keep using it until they end —
leave the droplet up until none are live or scheduled:

```sql
select slug, status, starts_at from webinars
 where sfu_project = 'blr1' and status in ('live','scheduled') order by starts_at;
```

---

## 6. Decommission Hetzner (after ~2 weeks)

1. Check nothing live or scheduled is on it:
   `select slug, status, starts_at from webinars where sfu_project = 'default' and status in ('live','scheduled');`
   Scheduled ones are fine — removing `default` re-pins them to `blr1` on their next join.
2. Remove the `default` entry from `LIVEKIT_PROJECTS`; redeploy the API.
3. Point `live.webinarliv.com` at the droplet too (Live origin DNS workflow) or set
   `BROADCAST_HLS_BASE=https://live-in.webinarliv.com/live`, so the global fallback is valid.
4. Delete the Hetzner server, its `HETZNER_SSH_*` secrets and its matrix entry in
   `.github/workflows/livekit-hetzner-deploy.yml`.

---

## Requirements for any provider

The stack in `deploy/livekit-hetzner/` is provider-agnostic: Ubuntu 22.04/24.04, root SSH,
a public IPv4 that the box sees (no NAT in front), ≥4 vCPU / 8 GB for LiveKit + Egress +
MediaMTX, and the inbound ports above. For a manual install instead of the workflow, see
`deploy/livekit-blr1.env.example`.
