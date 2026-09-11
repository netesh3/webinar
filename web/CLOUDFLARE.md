# Cloudflare hosting (frontend)

## Compatibility

This Next.js 16 App Router app **cannot** be a pure static Cloudflare Pages site:
it uses middleware (auth gate), Server Components that call the Go API, and
`generateMetadata` against the API.

**Recommended:** deploy with [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare)
to **Cloudflare Workers** (Cloudflare’s supported Next.js path; replaces
`@cloudflare/next-on-pages`).

## Same-origin `/api` proxy

The Worker entry is [`worker.ts`](./worker.ts): it proxies `/api/*` to
`API_INTERNAL_URL` (Cloud Run) and hands everything else to OpenNext.

That keeps the `webcast_session` cookie **first-party on the Worker origin**, so
Next middleware can gate `/host`, `/admin`, and `/my-webinars`. Pointing the
browser at Cloud Run directly (cross-site) stores the cookie on `*.run.app`,
which middleware on `*.workers.dev` never sees — users bounce back to login.

## Env vars

| Variable | When | Notes |
|----------|------|--------|
| `NEXT_PUBLIC_API_BASE` | **Build time** | Leave **empty** for Workers so the browser calls same-origin `/api/...`. Only set an absolute URL for local `next dev` against a separate API port. |
| `NEXT_PUBLIC_UI_REDESIGN` | **Build time** (+ wrangler `vars`) | `1` on Workers deploy so logged-out `/` is the marketing homepage. Override per browser with `?ui=classic` / cookie `webcast_ui`. Marketing always at `/home`. |
| `API_INTERNAL_URL` | Runtime (wrangler `vars`) | Absolute Cloud Run (or local API) URL. Used by SSR, middleware identity lookup, and the `/api` proxy. |

Google sign-in does **not** need `NEXT_PUBLIC_SUPABASE_*` on the Worker: the API
serves `supabaseUrl` / `supabaseAnonKey` / `googleAuth` from `/api/config` once
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_JWT_SECRET` are set on Cloud Run
(see [`deploy/SUPABASE.md`](../deploy/SUPABASE.md)). The browser uses `@supabase/ssr`
so the OAuth PKCE verifier is stored in first-party cookies on this Worker origin
(path `/`, `SameSite=Lax`) — required for `/auth/callback` after Google redirects.

No LiveKit or other secrets are required in the frontend Worker.

## Local preview (`.dev.vars`)

Copy [`.dev.vars.example`](./.dev.vars.example) → `.dev.vars` (gitignored). Point
`API_INTERNAL_URL` at local or Cloud Run. Do not put real anon keys in git.

## Deploy

### CI (GitHub Actions)

Push to `main` that touches `web/**` (or this workflow file) runs
[`.github/workflows/cloudflare-workers-deploy.yml`](../.github/workflows/cloudflare-workers-deploy.yml).
Manual runs: Actions → **Deploy Web (Cloudflare Workers)** → Run workflow.

| Kind | Name | Notes |
|------|------|--------|
| Secret | `CLOUDFLARE_API_TOKEN` | **Required to actually deploy.** Create at [API Tokens](https://dash.cloudflare.com/profile/api-tokens); use the **Edit Cloudflare Workers** template (or equivalent Workers Scripts Edit + Account read). |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | From `npx wrangler whoami` / dashboard. Already set on this repo when present. |

If `CLOUDFLARE_API_TOKEN` is missing, the workflow **skips deploy with a warning** (green check + annotation) instead of failing forever. Add the secret, then re-run **Deploy Web (Cloudflare Workers)** from the Actions tab.

Do **not** reuse a local `wrangler login` OAuth token for CI — create a dedicated API token.

### Manual (local)

```bash
cd web
npm ci
npm run deploy   # sets NEXT_PUBLIC_UI_REDESIGN=1, empty API base, OPEN_NEXT=1
```

**Homepage on this Worker:** logged-out `/` → marketing (new UI default). Signed-in `/` → `/host` or `/browse`. Always: [`/home`](https://webinar-web.ganesh-s-p006.workers.dev/home). If you previously chose classic UI, clear `webcast_ui` or open `/?ui=new`.

First-time login (if needed): `npx wrangler login`

Worker name: `webinar-web` (see `wrangler.jsonc`).

## Custom domain (`webinarliv.com`)

**Status (2026-09-11):** Zone **Active**; Workers custom domains
`webinarliv.com` + `www.webinarliv.com` attached to `webinar-web` with managed
HTTPS; `workers_dev` kept enabled. Supabase Auth `site_url` /
`uri_allow_list` updated for the new host (see below).

Prefer **full Cloudflare DNS** (nameservers at the registrar → Cloudflare), then attach
apex + `www` as Workers custom domains. Keep `*.workers.dev` working in parallel.

| Item | Value |
|------|--------|
| Domain | `webinarliv.com` (+ `www.webinarliv.com`) |
| Registrar | Spaceship |
| Cloudflare account | `392a7c7123d4be470145452fcd3f6840` (`ganesh.s.p006@gmail.com`) |
| Worker | `webinar-web` → https://webinar-web.ganesh-s-p006.workers.dev |

### 1. Add the zone in Cloudflare (dashboard required)

Wrangler OAuth can **read** zones and **edit** Workers, but it cannot
`account.zone.create`. Use the dashboard (not `wrangler` / API alone):

1. Open [Add site](https://dash.cloudflare.com/392a7c7123d4be470145452fcd3f6840/add-site).
2. Enter `webinarliv.com` → **Continue**.
3. Choose the **Free** plan → continue.
4. Skip or review DNS records (Worker custom domains will create what they need).
5. Copy the assigned **nameservers** (this account’s other zones use
   `anita.ns.cloudflare.com` / `lewis.ns.cloudflare.com` — confirm on the
   success screen; they may differ per zone).

Zone status stays **Pending** until the registrar NS change propagates.

### 2. Point Spaceship nameservers at Cloudflare

1. Open the domain in Spaceship:
   [domain product](https://www.spaceship.com/application/domain-list-application/?userProductId=ef8b4b33-c791-43e9-8e7e-c541f46fd6c7).
2. Find **Nameservers** / DNS management (not just A/CNAME records).
3. Switch from Spaceship defaults (`launch1.spaceship.net` /
   `launch2.spaceship.net`) to the two Cloudflare nameservers from step 1.
4. Save. Propagation is often minutes–hours; Cloudflare shows **Active** when
   ready.

Do **not** delete the domain. Leave Cloudflare proxy / SSL at defaults (Full or
Flexible is fine once the Worker custom domain issues a cert — custom domains
use Cloudflare-managed HTTPS).

### 3. Attach Worker custom domains

After the zone is **Active** (or once Cloudflare allows hostname association):

**Dashboard:** Workers & Pages → `webinar-web` → **Settings** → **Domains &
Routes** → **Add** → Custom domain → `webinarliv.com`, then again for
`www.webinarliv.com`.

**Or CLI** (from `web/`, after zone exists) — add to `wrangler.jsonc` then
deploy / triggers:

```jsonc
"routes": [
  { "pattern": "webinarliv.com", "custom_domain": true },
  { "pattern": "www.webinarliv.com", "custom_domain": true }
]
```

```bash
cd web
npx wrangler deploy   # or: npx wrangler triggers deploy
```

**Or API** (uses existing `wrangler login` OAuth — Workers write scope):

```bash
# ZONE_ID from: GET /zones?name=webinarliv.com
ACCT=392a7c7123d4be470145452fcd3f6840
# POST https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/domains
# body: {"hostname":"webinarliv.com","service":"webinar-web","environment":"production"}
# repeat for www.webinarliv.com
```

HTTPS certificates are provisioned automatically for Workers custom domains.

### 4. App / OAuth config (login on the new host)

Same-origin `/api` means the browser does not need CORS for normal UI→API
calls, but Cloud Run still has `CORS_ORIGINS` / `WEB_BASE_URL` for share links
and any direct API access.

| Where | What to set |
|-------|-------------|
| Cloud Run + GitHub secrets | `CORS_ORIGINS=https://webinarliv.com,https://www.webinarliv.com,https://webinar-web.ganesh-s-p006.workers.dev` |
| Cloud Run + GitHub secrets | `WEB_BASE_URL=https://webinarliv.com` |
| Supabase Auth → URL config | Site URL: `https://webinarliv.com`; Redirect URLs: `https://webinarliv.com/auth/callback`, `https://www.webinarliv.com/auth/callback`, keep workers.dev + localhost |
| Google Cloud OAuth client (optional JS origins) | Add `https://webinarliv.com` and `https://www.webinarliv.com` |

Session cookie is host-only on the Worker origin (no shared `Domain=` cookie
across apex/www). Prefer one canonical host (apex) and redirect `www` → apex if
you want a single session.

`NEXT_PUBLIC_API_BASE` stays **empty** at Worker build time.

### 5. Test URLs

- https://webinar-web.ganesh-s-p006.workers.dev/ (must keep working)
- https://webinarliv.com/
- https://www.webinarliv.com/
- https://webinarliv.com/auth/callback (after Google sign-in)
- https://webinarliv.com/api/config (proxied API)
