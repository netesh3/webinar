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
| `API_INTERNAL_URL` | Runtime (wrangler `vars`) | Absolute Cloud Run (or local API) URL. Used by SSR, middleware identity lookup, and the `/api` proxy. |

Google sign-in does **not** need `NEXT_PUBLIC_SUPABASE_*` on the Worker: the API
serves `supabaseUrl` / `supabaseAnonKey` / `googleAuth` from `/api/config` once
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_JWT_SECRET` are set on Cloud Run
(see [`deploy/SUPABASE.md`](../deploy/SUPABASE.md)).

No LiveKit or other secrets are required in the frontend Worker.

## Local preview (`.dev.vars`)

Copy [`.dev.vars.example`](./.dev.vars.example) → `.dev.vars` (gitignored). Point
`API_INTERNAL_URL` at local or Cloud Run. Do not put real anon keys in git.

## Deploy

```bash
cd web
npm ci

# Same-origin API via Worker proxy (required for session + middleware)
export NEXT_PUBLIC_API_BASE=""
export OPEN_NEXT=1

npm run deploy
```

First-time login (if needed): `npx wrangler login`

Worker name: `webinar-web` (see `wrangler.jsonc`).
