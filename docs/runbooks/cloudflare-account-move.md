# Cutover: Cloudflare personal account to company account

This runbook moves everything Webinar Liv runs on Cloudflare from the owner's personal account
(`392a7c7123d4be470145452fcd3f6840`, nameservers `anita` / `lewis`) to the company account
(`cb9814264e4657f60ee8961f546c6a0e`, nameservers `jean` / `lou`). Written 30 Oct 2026.

The repo does not hard-code the account. CI reads it from the repository variable
`CLOUDFLARE_ACCOUNT_ID`. The API and the publish jobs read it from secrets
(`RECORDINGS_S3_ENDPOINT`, `R2_DOWNLOADS_ACCOUNT_ID`, `CLOUDFLARE_AI_ACCOUNT_ID`). The only
account-bound ID in git is the email worker's KV namespace in
`deploy/cloudflare/email-inbound/wrangler.toml`, which the cutover PR changes.

Already done in the company account:
- R2 buckets `webinar-recordings-prod` (CORS copied, objects copied with Super Slurper) and
  `webinarliv-downloads`.
- Zone `webinarliv.com` added (Pending).
- KV namespace `937a47f5a1454fe8abd5ab13ca741c51` for the email worker.

The old account stays untouched until Cleanup. Until then, you can roll back any step by
switching the nameservers back.

```bash
R=github.com/netesh3/webinar
API=https://webcast-api-65278594492.asia-south1.run.app
```

## 1. Preconditions

- [ ] **No live webinar or meeting in the next 2 hours.** Ask the API (this needs the `TICK_SECRET` value):

  ```bash
  curl -s -H "X-Tick-Secret: $TICK_SECRET" "$API/api/internal/live-status"
  # want: "count":0, "live":[]
  ```

  `live-status` only lists sessions that are live or start within 10 minutes. Also check the
  admin schedule for anything booked in the next 2 hours.
- [ ] **The Super Slurper copy is done.** In the company account, R2 → Data Migration shows the job
  as Completed, with no failed objects. Compare the object counts of `webinar-recordings-prod` in
  both accounts (R2 → bucket → Metrics, or `aws s3 ls --recursive --summarize` against each
  account's `https://<account>.r2.cloudflarestorage.com`).
- [ ] **DNS records match.** In the old account, export the `webinarliv.com` DNS records (DNS →
  Records → Export) and compare them with the new zone. Recreate any missing record that is not a
  worker record (TXT verifications, the `auth` CNAME, and so on). In the new zone, **delete any
  imported `A`/`AAAA`/`CNAME` for `webinarliv.com`, `www`, `recordings` and `downloads`**. Workers
  custom domains and R2 custom domains refuse a hostname that already has a record.
- [ ] **Zone rules match.** In the new zone, recreate whatever the old zone has under Rules,
  Caching → Cache Rules, the SSL/TLS mode and Security (for example the cache rule for
  `recordings.webinarliv.com`).
- [ ] **No merges to `web/**`** from the moment you switch the variable (section 3) until Deploy Web
  runs in section 5. A push-triggered deploy would target the new account before its zone is Active.

## 2. Owner creates tokens in the company account

Create each token while logged in as a member of the company account. Paste every value
straight into the `gh` prompt in section 3, and don't save it anywhere else.

**(a) CI API token → `CLOUDFLARE_API_TOKEN`.** Go to My Profile → API Tokens → Create Token and
pick the **Edit Cloudflare Workers** template. (An account-owned token from Manage Account →
API Tokens also works: both deploy workflows that check the token accept either kind.)
- Account Resources: Include → only the company account (`cb98…6a0e`).
- Zone Resources: Include → Specific zone → `webinarliv.com`.
- Permissions: keep the template as it is. What the three deploy workflows do, and what each
  step needs:
  - `wrangler deploy` of `webinar-web`, `webinarliv-tick` and `webinar-email-inbound`, plus
    `wrangler secret put`: **Account · Workers Scripts · Edit** (in the template).
  - `webinar-web` claims `webinarliv.com` and `www` as Workers custom domains: **Zone · Workers
    Routes · Edit** (in the template) on `webinarliv.com`. Cloudflare creates the custom-domain
    DNS records itself, so Zone · DNS · Edit is not needed.
  - The email worker binds an existing KV namespace by ID: **Account · Workers KV Storage · Edit**
    (in the template).
  - The tick worker's cron trigger: covered by Workers Scripts · Edit.
  - The template's extras (Account Settings Read, Workers Tail Read, User Details Read,
    Memberships Read) let wrangler resolve the account. Keep them.
  - **Not added:** Email Routing Rules Edit, because you set routing in the dashboard (section 5)
    and no workflow touches it. Zone DNS Edit, for the reason above: add it only if Deploy Web
    fails with a custom-domain DNS permission error.
- TTL: none. Client IP filtering: none, because GitHub runners have no fixed IPs.

**(b) R2 recordings token → `RECORDINGS_S3_ACCESS_KEY` / `RECORDINGS_S3_SECRET_KEY`.** Go to R2 →
Manage R2 API Tokens → Create Account API token → **Object Read & Write**, Specify bucket →
`webinar-recordings-prod`. These keys are used by:
- the API
- LiveKit Egress uploads (the API hands the keys over per request)
- DB backup, the restore test and the recordings audit

**(c) R2 admin token → `R2_ADMIN_ACCESS_KEY` / `R2_ADMIN_SECRET_KEY`.** Go to R2 → Manage R2 API
Tokens → **Admin Read & Write**. Only `r2-lifecycle.yml` uses it, for the bucket lifecycle rules,
which the object token cannot write.

**(d) R2 downloads token → `R2_DOWNLOADS_ACCESS_KEY_ID` / `R2_DOWNLOADS_SECRET_ACCESS_KEY`.** Go to
R2 → Manage R2 API Tokens → **Object Read & Write**, Specify bucket → `webinarliv-downloads`.
`desktop-build.yml` and `mobile-build.yml` use it to publish.

**(e) Workers AI token → `CLOUDFLARE_AI_TOKEN`.** Go to My Profile (or Manage Account) → API
Tokens → Create Token and pick the **Workers AI** template (Account · Workers AI · Read and
Edit). Account Resources → the company account.

## 3. Set GitHub secrets and variables

A `gh secret set` without `--body` reads the value from a hidden prompt, so the value never
lands in shell history. You can run these from any directory.

```bash
R=github.com/netesh3/webinar

# Tokens: paste each value at the prompt
gh secret set CLOUDFLARE_API_TOKEN            -R $R   # (a)
gh secret set RECORDINGS_S3_ACCESS_KEY        -R $R   # (b) Access Key ID
gh secret set RECORDINGS_S3_SECRET_KEY        -R $R   # (b) Secret Access Key
gh secret set R2_ADMIN_ACCESS_KEY             -R $R   # (c) Access Key ID
gh secret set R2_ADMIN_SECRET_KEY             -R $R   # (c) Secret Access Key
gh secret set R2_DOWNLOADS_ACCESS_KEY_ID      -R $R   # (d) Access Key ID
gh secret set R2_DOWNLOADS_SECRET_ACCESS_KEY  -R $R   # (d) Secret Access Key
gh secret set CLOUDFLARE_AI_TOKEN             -R $R   # (e)

# Values that are not secret
gh variable set CLOUDFLARE_ACCOUNT_ID    -R $R --body cb9814264e4657f60ee8961f546c6a0e
gh secret   set R2_DOWNLOADS_ACCOUNT_ID  -R $R --body cb9814264e4657f60ee8961f546c6a0e
gh secret   set CLOUDFLARE_AI_ACCOUNT_ID -R $R --body cb9814264e4657f60ee8961f546c6a0e
# Endpoint only, with no bucket in the URL. The bucket is RECORDINGS_S3_BUCKET (unchanged,
# webinar-recordings-prod), and every client uses path-style addressing
# (deploy/cloudrun.env.example, api/internal/media/s3.go).
gh secret   set RECORDINGS_S3_ENDPOINT   -R $R --body https://cb9814264e4657f60ee8961f546c6a0e.r2.cloudflarestorage.com
```

These stay the same: `RECORDINGS_S3_BUCKET`, `RECORDINGS_S3_REGION` (`auto`), `TICK_SECRET`,
`INBOX_WEBHOOK_SECRET` and the `R2_DOWNLOADS_BUCKET` variable (if set).

The API keeps running on the old values until its next deploy (section 5). The old bucket is
still there, so nothing breaks in between.

## 4. Nameserver switch

1. At Spaceship, open `webinarliv.com` → Nameservers → Custom. Replace `anita.ns.cloudflare.com` /
   `lewis.ns.cloudflare.com` with **`jean.ns.cloudflare.com`** and **`lou.ns.cloudflare.com`**, then
   Save.
2. In the company account, open Websites → `webinarliv.com` → **Check nameservers now**. Wait until
   the zone shows **Active** (usually minutes, but it can take hours), and note the time.

   ```bash
   dig +short NS webinarliv.com @1.1.1.1   # want jean / lou
   ```

Until Deploy Web finishes, resolvers that already follow the new nameservers get no site. Start
section 5 as soon as the zone is Active.

## 5. Right after Active

1. **Merge the cutover PR** (the email worker's KV ID and `email-inbound-deploy.yml`). The merge
   itself triggers Email inbound deploy.
2. **Deploy the three workers.** The deploy guard on Deploy Web still applies. Use `force` only
   if you have checked live-status yourself.

   ```bash
   gh workflow run cloudflare-workers-deploy.yml -R $R
   gh workflow run tick-worker-deploy.yml        -R $R
   gh workflow run email-inbound-deploy.yml      -R $R   # only if the run started by the merge did not succeed
   gh run list -R $R --limit 5
   ```

   Then open Workers & Pages → `webinar-web` → Settings → Domains & Routes and confirm that
   `webinarliv.com` and `www.webinarliv.com` are attached.
3. **R2 custom domains.** Go to R2 → `webinar-recordings-prod` → Settings → Custom Domains → Connect
   and enter `recordings.webinarliv.com`. Do the same on `webinarliv-downloads` with
   `downloads.webinarliv.com`. Wait for both to show Active. Leave public `r2.dev` access off.
4. **Email Routing.** Go to Websites → `webinarliv.com` → Email → Email Routing:
   - Enable Email Routing and let it add its MX and TXT records.
   - Destination addresses: add `webinarliv@gmail.com`, then click the link in the verification mail.
   - Routing rules → Custom addresses: create these 9 rules, each **Send to an email** →
     `webinarliv@gmail.com`: `support`, `invite`, `security`, `hello`, `billing`, `privacy`,
     `legal`, `abuse`, `partners`.
   - Catch-all address: set the action to **Send to a Worker** → `webinar-email-inbound`, and
     enable it.
5. **SPF.** In DNS → Records, there must be exactly one `TXT` record at `webinarliv.com` starting
   with `v=spf1`. It must include `include:_spf.mx.cloudflare.net`. If the old record had other
   `include:` entries, merge them in.

   ```bash
   dig +short TXT webinarliv.com @jean.ns.cloudflare.com
   ```
6. **Second Super Slurper copy.** This picks up objects written since the first copy. Go to R2 →
   Data Migration → new job, with the same source and destination and overwrite off. The
   migration source token from the first run was a 1-day token, so if it has expired, make a new
   short-lived one. Wait for Completed.
7. **Deploy the API** so Cloud Run picks up the new R2 and Workers AI secrets:

   ```bash
   gh workflow run cloudrun-deploy.yml -R $R
   ```
8. **R2 lifecycle** on the new bucket. Do a dry run first, then the real run:

   ```bash
   gh workflow run r2-lifecycle.yml -R $R -f dry_run=true
   gh workflow run r2-lifecycle.yml -R $R -f dry_run=false
   ```

## 6. Verify

```bash
curl -sI https://webinarliv.com/            | head -1               # 200
curl -sI https://www.webinarliv.com/pricing | grep -i '^location'   # → https://webinarliv.com/pricing
curl -s  https://webinarliv.com/api/config  | head -c 200           # API through the Worker proxy
curl -sI https://webinarliv.com/.well-known/apple-app-site-association | head -1   # 200
curl -sI https://webinarliv.com/.well-known/assetlinks.json            | head -1   # 200
curl -sI https://webinarliv.com/.well-known/security.txt               | head -1   # 200
curl -sI "https://recordings.webinarliv.com/<key of an existing object>" | head -1 # 200 (take a key from the bucket browser)
curl -sI https://downloads.webinarliv.com/latest.json                  | head -1   # 200
```

- [ ] The site, the `www` redirect and `/api/*` through the site all work. Sign in once in a browser.
- [ ] The `/.well-known/*` files serve with the right content type.
- [ ] `recordings.webinarliv.com` serves an existing object, and a recording plays in the app.
- [ ] Mail: a test sent to `support@webinarliv.com` arrives at webinarliv@gmail.com. A test sent to
  a host's inbox address shows up in that host's Inbox in the app.
- [ ] Tick: Workers & Pages → `webinarliv-tick` → Logs shows a run every minute, and Cloud Run
  shows the calls:

  ```bash
  gcloud logging read --project selfreminder-rnix --freshness 10m --limit 20 \
    'resource.type="cloud_run_revision" AND resource.labels.service_name="webcast-api" AND httpRequest.requestUrl:"/api/internal/tick"' \
    --format 'value(timestamp,httpRequest.status)'
  ```
- [ ] Upload a short test video and record a short test session. Both should land in the new
  bucket (R2 → `webinar-recordings-prod` → objects, newest first) and play back.
- [ ] The links on the downloads page resolve on `downloads.webinarliv.com`.

## 7. Rollback

At Spaceship, set the nameservers back to `anita.ns.cloudflare.com` / `lewis.ns.cloudflare.com`.
The old account's zone, workers, buckets and KV are untouched until Cleanup, so the old setup
serves again as resolvers follow the change. To point CI and the API back as well, set the
section 3 values back to the old account's tokens and IDs, and re-run Deploy API.

## 8. Cleanup (48 hours after Active, if nothing went wrong)

- [ ] Old account → Websites → `webinarliv.com` → Remove site.
- [ ] Old account → Workers & Pages: delete `webinar-web`, `webinarliv-tick` and
  `webinar-email-inbound`.
- [ ] Old account → R2: after the second copy, confirm the object counts match the new buckets.
  Then empty and delete `webinar-recordings-prod` and `webinarliv-downloads`.
- [ ] Old account → Workers KV: delete namespace `c469f6a2205040db9c531a4a8615bee1`. If you need
  any `mail:*` keys, read them out first.
- [ ] Revoke these old tokens:
  - the old account's API tokens (Workers CI, Workers AI)
  - its R2 tokens (recordings, admin, downloads)
  - the two 1-day migration tokens Super Slurper used
- [ ] Remove the old `https://webinar-web.ganesh-s-p006.workers.dev` origin everywhere it was
  allowed:
  - the CORS policy on the new `webinar-recordings-prod` bucket
  - the `CORS_ORIGINS` secret (then re-run Deploy API)
  - the Supabase Auth redirect URLs
  - the Google OAuth client's origins and redirect URIs

  Add the company account's `webinar-web.<subdomain>.workers.dev` instead only if you want that
  copy to be usable.
