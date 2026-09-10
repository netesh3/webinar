# Cloudflare hosting (frontend)

## Compatibility

This Next.js 16 App Router app **cannot** be a pure static Cloudflare Pages site:
it uses middleware (auth gate), Server Components that call the Go API, and
`generateMetadata` against the API.

**Recommended:** deploy with [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare)
to **Cloudflare Workers** (Cloudflare’s supported Next.js path; replaces
`@cloudflare/next-on-pages`).

## Env vars

| Variable | When | Notes |
|----------|------|--------|
| `NEXT_PUBLIC_API_BASE` | **Build time** | Public API origin, e.g. `https://….run.app`. Inlined into the browser bundle. |
| `API_INTERNAL_URL` | Runtime (wrangler `vars`) | Absolute URL for SSR/middleware fetches. Defaults to `NEXT_PUBLIC_API_BASE` if unset. |

No LiveKit or other secrets are required in the frontend Worker.

## Deploy

```bash
cd web
npm ci

# Point at your API (Cloud Run URL once it exists)
export NEXT_PUBLIC_API_BASE="https://YOUR-API.example.com"
export OPEN_NEXT=1

# Optional: set SSR/middleware target in wrangler.jsonc → vars.API_INTERNAL_URL
# to the same origin (or an internal URL if you later add service bindings).

npm run deploy
```

First-time login (if needed): `npx wrangler login`

Worker name: `webinar-web` (see `wrangler.jsonc`).
