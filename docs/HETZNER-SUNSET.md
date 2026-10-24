# Sunsetting the Hetzner video server

Status (2026-10-24): **not started — do nothing yet.** The code side is done (PR #700): the
Hetzner LiveKit project (`default`) takes no new rooms, upcoming webinars pinned to it are
moved to the DigitalOcean box (`do-blr`) at boot or at their next join, edge delivery is the
default for every new webinar, and the "Edge delivery (beta)" switch is gone. The Hetzner
server itself, its secrets, DNS and CDN are all still in place. Everything below is manual
and is to be done later, in this order.

`deploy/livekit-hetzner/` is **not** Hetzner-only: the DigitalOcean box image, its boot
script and its deploy all use it. Keep it; renaming it (e.g. to `deploy/livekit-box/`) is a
separate tidy-up.

## 1. Nothing left on Hetzner

Run in the Supabase SQL editor (read-only):

```sql
SELECT slug, status, starts_at
  FROM webinars
 WHERE sfu_project = 'default' AND status IN ('live', 'draft', 'scheduled');
```

Wait until it returns no rows. A session in the past that never went live can still show
here with status `scheduled` (the app treats it as over); re-point it so it stops counting:

```sql
UPDATE webinars SET sfu_project = 'do-blr'
 WHERE slug = '<slug>' AND sfu_project = 'default';
```

Ended webinars pinned to `default` are fine to leave: they don't use the video server, and
their recordings are served from storage.

## 2. Take `default` out of the API's server list

Order matters. The `default` entry in the `LIVEKIT_PROJECTS` secret leaves out its URL and
keys and borrows them from the legacy `LIVEKIT_URL` / `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET` secrets (`api/internal/config/livekit.go`). Deleting those three first
would make the next deploy fail to boot with "url is required". So:

1. Copy the current `LIVEKIT_PROJECTS` value (GitHub never shows it; take it from Cloud Run
   → webcast-api → Revisions → latest → Variables & Secrets) to the clipboard, then:

   ```sh
   pbpaste | python3 -c 'import json,sys; p=[x for x in json.load(sys.stdin) if x.get("id")!="default"]; sys.stderr.write("keeping: %s\n" % [x.get("id") for x in p]); print(json.dumps(p))' \
     | gh secret set LIVEKIT_PROJECTS -R github.com/netesh3/webinar
   ```

   It prints only the ids it keeps (expect `do-blr` and `india`). To drop `india` too, use
   `x.get("id") not in ("default", "india")`.
2. Then delete the legacy trio (the deploy script recreates a `default` entry whenever they
   are set):

   ```sh
   gh secret delete LIVEKIT_URL -R github.com/netesh3/webinar
   gh secret delete LIVEKIT_API_KEY -R github.com/netesh3/webinar
   gh secret delete LIVEKIT_API_SECRET -R github.com/netesh3/webinar
   ```
3. Redeploy the API (`gh workflow run cloudrun-deploy.yml -R github.com/netesh3/webinar --ref main`)
   and check its boot log: `livekit projects` should list only the kept ids, with nothing
   under `retired`. Then confirm ticks (`/api/internal/tick` taking about a second) and a
   test join.

## 3. DNS and CDN

- `live.webinarliv.com`: repoint it to the box's reserved IP or delete it.
  `.github/workflows/live-origin-dns.yml` now defaults to the DigitalOcean reserved IP.
- Bunny pull zone `webinarlivlive` and the `EDGE_PLAYBACK_BASE` variable: the zone's origin
  is probably still Hetzner. `do-blr` has its own edge playback base in `LIVEKIT_PROJECTS`,
  so either repoint the zone at the box or delete the zone and the variable.
- Check `BROADCAST_HLS_BASE` (secret) doesn't point at the Hetzner server.

## 4. GitHub secrets

Nothing reads these any more (the two Hetzner-only workflows were removed in #700):

```sh
gh secret delete HETZNER_SSH_HOST -R github.com/netesh3/webinar
gh secret delete HETZNER_SSH_PRIVATE_KEY -R github.com/netesh3/webinar
```

Keep `GRAFANA_ADMIN_PASSWORD`: the DigitalOcean box deploy uses it.

## 5. The server itself (last)

1. Copy anything worth keeping off the server's `/opt/livekit` (configs, local recordings or
   logs).
2. Delete it: `hcloud server delete webcast-livekit` and
   `hcloud firewall delete webcast-livekit-fw`; remove any snapshots, volumes or primary IPs
   left on the Hetzner project.
3. Cancel Hetzner billing.

## Kept on purpose

- The admin cost calculator's Hetzner option and the cost report's Hetzner pricing: they are
  a price comparison and price past sessions that ran on `default`.
- The GCP `india` project and its egress workers (`egress-pool.yml`, `EGRESS_INDIA_*`): not
  Hetzner; a separate decision.
