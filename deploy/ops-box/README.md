# Ops box (`ops-blr-1`)

A tiny always-on DigitalOcean droplet whose only job is the API's one-minute background pass:
`POST /api/internal/tick` with `X-Tick-Secret`. The API runs on Cloud Run, which gives it CPU
only while a request is in flight, so reminders, drips, simulive starts and the **on-demand video
server** (`api/internal/api/sfu_box.go`, which is stepped by the tick) need an outside caller.
That used to be the video server's own cron; the video server is now deleted when idle, so the
caller has to be a box that is always there.

| Item | Value |
|------|-------|
| Droplet | `ops-blr-1`, `s-1vcpu-1gb`, `blr1`, Ubuntu 24.04 |
| Cost | ~$6/month ($0.00893/h) |
| Runs | cron `* * * * *` → `/usr/local/sbin/webinarliv-tick` (logs: `journalctl -t webinarliv-tick`) |
| Secrets | `/etc/webinarliv/tick.header` (mode 600, a curl header file), URL in `/etc/webinarliv/tick.env` |
| Firewall | ufw: SSH only. Optionally a cloud firewall `ops-ssh` (22/tcp in, all out) |

Files: `install.sh` (packages, the cron, the secret), `tick.sh` (one pass), `cloud-init.yaml`
(user data that downloads both; no secrets in it).

## Create it

```bash
doctl --context webinarliv compute droplet create ops-blr-1 --region blr1 --size s-1vcpu-1gb \
  --image ubuntu-24-04-x64 --ssh-keys 60277972 --enable-monitoring --tag-names webinar-ops \
  --project-id 47cff897-9b50-4304-836b-93325c398ee7 \
  --user-data-file deploy/ops-box/cloud-init.yaml --wait
OPS_IP=$(doctl --context webinarliv compute droplet get ops-blr-1 --format PublicIPv4 --no-header)

# The secret from the same place as the API's TICK_SECRET (never echo it):
printf '%s' "$TICK_SECRET" | ssh root@$OPS_IP \
  'TICK_URL=https://webcast-api-65278594492.asia-south1.run.app/api/internal/tick bash /opt/ops-box/install.sh'
# … ends with "Tick OK: every minute to https://…/api/internal/tick"
```

Then stop the video server's own cron: `OPS_BOX=true` in its `/opt/livekit/.env` and
`redeploy.sh` (on-demand boxes set it themselves, `deploy/digitalocean/sfu-boot.sh`). Two
callers at once are harmless anyway: the API takes a lease, and the second answers `busy`.

## Check

```bash
ssh root@$OPS_IP 'journalctl -t webinarliv-tick --since "-10 min"'   # empty = every call succeeded
ssh root@$OPS_IP /usr/local/sbin/webinarliv-tick && echo ok
```

If it stops, nothing breaks at once, but nothing on a clock happens either: reminders wait,
and the video server is neither started ahead of a session (a join still starts it) nor deleted
when idle (it keeps billing). The backup caller below covers that. The Cloud Scheduler job
(`deploy/cloud-scheduler-tick.sh`) is another fallback if this droplet is ever retired.

## Backup caller

A Cloudflare Worker, `webinarliv-tick` (`deploy/cloudflare/tick-worker/`), makes the same call
every minute from a cron trigger, so the clock keeps running if this droplet is down. It is a
separate worker from the web app (no routes, no custom domain). Both callers hitting the same
minute is fine: the API's lease lets one pass run and the other gets `200 {"status":"busy"}`,
which the worker counts as success (as is `ran`). Anything else is logged as an error.

| Item | Value |
|------|-------|
| Code | `src/index.js` (`scheduled()` → POST `TICK_URL` with `X-Tick-Secret`, 55 s abort) |
| URL | `TICK_URL` var in `wrangler.toml` (the Cloud Run API) |
| Secret | Worker secret `TICK_SECRET`, set by CI from the GitHub secret of the same name |
| Deploy | `.github/workflows/tick-worker-deploy.yml`: push to main under `deploy/cloudflare/tick-worker/**`, or run it by hand. `wrangler deploy`, then `wrangler secret put` from stdin |
| Logs | Cloudflare dashboard → Workers → `webinarliv-tick` → Logs (observability on), or `npx wrangler tail webinarliv-tick` |
| Test | `cd deploy/cloudflare/tick-worker && npm test` |

Limits: the free plan allows cron triggers (5 per account; this uses 1) and ~1,440
invocations a day, well under the daily request cap. The 10 ms CPU limit is CPU time, not wall
time: waiting on the API's response does not count, and a cron invocation may run for minutes
of wall time, so the 55 s timeout is the real bound. Cron timing is best-effort (can drift by
seconds), which is fine for a backup.

To stop it: `npx wrangler delete webinarliv-tick` (or remove the cron in `wrangler.toml` and
redeploy).
