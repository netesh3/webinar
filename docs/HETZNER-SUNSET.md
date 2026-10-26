# Hetzner sunset

Status (2026-10-26): **the Hetzner server is deleted.** It was `webcast-livekit` (CX33, fsn1,
88.198.141.104), LiveKit project `default`. Production video is the on-demand DigitalOcean box
(`do-blr`, deploy/digitalocean/README.md). The GCP test project `india` is disabled and its VMs
are deleted too.

## Done in the code

- **#700 (2026-10-24):** no new room goes to a Hetzner project, upcoming webinars pinned to it move
  to the box, the "Edge delivery (beta)" switch is gone, and the two Hetzner-only workflows
  (deploy over SSH, logs) were removed.
- **This change (2026-10-26):**
  - `deploy/livekit-hetzner/` is renamed **`deploy/livekit-box/`**: it is the stack every video
    box runs. Every reference moved with it: the DigitalOcean deploy workflow, the snapshot
    build (`build-image.sh`, `build-captions-image.sh`), the boot scripts (`sfu-boot.sh`,
    `captions-boot.sh`), CI, the docs and the code comments. Applied migrations keep the old
    path in their comments; they are never edited.
  - **Disabled projects are retired too** (`api/internal/api/sfu_retired.go`): a draft or
    scheduled webinar pinned to one moves to the box at boot or at its next join, as a
    Hetzner-pinned one does. Before, a disabled project kept the webinars pinned to it, so one
    on `india` would have joined a deleted server. A session live on a disabled project keeps
    it until it ends. A project removed from `LIVEKIT_PROJECTS` altogether was already handled:
    its webinars repin at their next join (`sfu.go`, `repin`).
  - `live.webinarliv.com` is gone from the box: its Caddy site block and the
    `live-origin-dns.yml` workflow are removed. It was the Cloudflare-proxied Hetzner origin and
    answers nothing now.
  - The admin cost calculator no longer offers Hetzner. The cost report keeps Hetzner, labelled
    "retired", for pricing the sessions that ran there.
  - The stack README, the DigitalOcean README, the topology, edge-delivery and adding-an-SFU
    docs, the env examples and the deploy workflow comments no longer describe Hetzner as
    current.

## Your checklist

Order matters: the `default` entry in `LIVEKIT_PROJECTS` takes its URL and keys from the legacy
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` secrets (`api/internal/config/livekit.go`),
so deleting those three while the entry is still there would make the next deploy fail to boot
("url is required").

1. **Check nothing live or upcoming is on `default` or `india`** (Supabase SQL editor, read-only):

   ```sql
   SELECT slug, status, sfu_project FROM webinars
    WHERE sfu_project IN ('default', 'india') AND status IN ('live', 'draft', 'scheduled');
   ```

   Draft and scheduled ones move by themselves (at boot, or at their next join). A `live` row
   is a session stuck as live on a deleted server: end it from Admin → Sessions.

2. **Remove `default` and `india` from `LIVEKIT_PROJECTS`.** This reads the current value from
   Cloud Run, drops the two entries, prints only the ids it keeps, and stores the result without
   printing it:

   ```sh
   gcloud run services describe webcast-api --region asia-south1 --project selfreminder-rnix --format=json \
     | python3 -I -c "import json,sys; env={e['name']:e.get('value') for e in json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env',[])}; ps=[p for p in json.loads(env['LIVEKIT_PROJECTS']) if p.get('id') not in ('default','india')]; sys.stderr.write('keeping: %s\n' % [p.get('id') for p in ps]); sys.stdout.write(json.dumps(ps))" \
     | gh secret set LIVEKIT_PROJECTS -R github.com/netesh3/webinar
   ```

   Expect `keeping: ['do-blr']`, plus any box slots you added.

3. **Delete the legacy trio** (the deploy script re-creates a `default` entry whenever they are set):

   ```sh
   gh secret delete LIVEKIT_URL -R github.com/netesh3/webinar
   gh secret delete LIVEKIT_API_KEY -R github.com/netesh3/webinar
   gh secret delete LIVEKIT_API_SECRET -R github.com/netesh3/webinar
   ```

4. **Point the global live-origin fallbacks at the box** (they still name the dead Hetzner origin;
   `do-blr` has its own, so this only matters for a project without them):
   - secret `BROADCAST_HLS_BASE` → `https://152.42.156.192.sslip.io/live` (it can't simply be
     deleted: it must be set together with `BROADCAST_RTMP_BASE`)
   - variable `EDGE_PLAYBACK_BASE` → `https://webinarlivindiav.b-cdn.net/live`, or delete it

   ```sh
   gh secret set BROADCAST_HLS_BASE -R github.com/netesh3/webinar --body "https://152.42.156.192.sslip.io/live"
   gh variable set EDGE_PLAYBACK_BASE -R github.com/netesh3/webinar --body "https://webinarlivindiav.b-cdn.net/live"
   ```

5. **Redeploy the API** (`gh workflow run cloudrun-deploy.yml -R github.com/netesh3/webinar --ref main`)
   and check its boot log: `livekit projects` lists only `do-blr` (and any slots). Then a test join.

6. **Delete the Hetzner leftovers elsewhere:**
   - GitHub secrets `HETZNER_SSH_HOST` and `HETZNER_SSH_PRIVATE_KEY` (nothing reads them):
     `gh secret delete HETZNER_SSH_HOST -R github.com/netesh3/webinar`, then the same for
     `HETZNER_SSH_PRIVATE_KEY`.
   - Cloudflare DNS: the `live.webinarliv.com` record (it pointed at Hetzner; nothing uses it).
   - Bunny: the pull zone `webinarlivlive` (origin Hetzner; it answers 504). Keep
     `webinarlivindiav`, which is the box's.
   - Hetzner Cloud: any snapshots, volumes, primary IPs or firewalls left
     (`hcloud firewall delete webcast-livekit-fw`), then cancel the billing.

Keep `GRAFANA_ADMIN_PASSWORD`: the DigitalOcean box deploy uses it.

## Kept on purpose

- `CostProviderHetzner` and the Hetzner prices in `web/lib/cost-calculator.ts` /
  `web/lib/host-costs.ts`: the cost report prices sessions that ran on `default`, and an ended
  webinar's `sfu_project` stays as the record of where it ran.
- The legacy `LIVEKIT_URL` trio support in `api/internal/config/livekit.go`: it is how a dev
  stack configures one LiveKit, and a deployment without `LIVEKIT_PROJECTS` still works.
- The Hetzner-retirement code (`sfu_retired.go`): harmless once `default` is gone, and it now
  also retires disabled projects.
- The GCP egress pool workflow (`egress-pool.yml`, `EGRESS_INDIA_*`) and the `india` project
  code paths: GCP, not Hetzner; a separate clean-up now that `india` is disabled.
