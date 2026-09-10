# Supabase for Webcast (production Postgres)

Local development keeps self-hosted Postgres (`docker-compose.yml` / Homebrew via
`make db`). **Production / Cloud Run** should use a Supabase Postgres project and
pass its connection string as `DATABASE_URL`.

The Go API opens Postgres with **pgx** (`store.Open`) and runs embedded SQL
migrations on every boot (`st.Migrate` in `api/cmd/server`). No separate migrate
service is required for deploy, but a one-shot migrate before the first traffic
is useful to fail fast.

## Prerequisites

```bash
# CLI (optional; Dashboard also works)
brew install supabase/tap/supabase   # or: npx supabase
supabase login                       # opens browser / paste access token
supabase projects list               # confirms auth
```

Or set `SUPABASE_ACCESS_TOKEN` from https://supabase.com/dashboard/account/tokens

## Create or reuse a project

```bash
# List existing (reuse one named webinar/webcast if you already have it)
supabase projects list

# Create (interactive region/org prompts vary by CLI version)
supabase projects create webcast --org-id <ORG_ID> --db-password <STRONG_PASSWORD> --region us-east-1
```

Dashboard alternative: https://supabase.com/dashboard → New project → name `webcast`
(or `webinar`) → save the database password.

## Connection strings

Project → **Settings → Database → Connection string**.

| Use | Host / port | Notes |
|---|---|---|
| **Migrations / preferred for this app** | Direct: `db.<PROJECT_REF>.supabase.co:5432` | Full Postgres session. Use for `make migrate` / first boot. |
| **Cloud Run (optional pooler)** | Transaction pooler `:6543` | Add `sslmode=require` and `default_query_exec_mode=simple_protocol` (pgx prepared statements break under transaction pooling). |

Always include **`sslmode=require`**. Supabase rejects non-TLS clients.

Example shapes (passwords redacted — never commit real URLs):

```text
# Direct (recommended starting point for Cloud Run + migrate)
postgres://postgres:SECRET@db.<PROJECT_REF>.supabase.co:5432/postgres?sslmode=require

# Transaction pooler (scale-out / many short-lived Cloud Run instances)
postgres://postgres.<PROJECT_REF>:SECRET@aws-0-<REGION>.pooler.supabase.com:6543/postgres?sslmode=require&default_query_exec_mode=simple_protocol
```

Database name is usually `postgres`. That is fine for a dedicated project; the
app creates its own tables via migrations.

### pgx / pool behaviour

- `store.Open` uses a `pgxpool` (MaxConns=20). Direct Supabase is enough for
  Cloud Run `--max-instances 3`.
- Migrations wrap each file in a transaction and record versions in
  `schema_migrations`. Prefer the **direct** URL for one-shot migrate.
- Boot migrate still runs on the URL you set for Cloud Run; if you use the
  transaction pooler at runtime, either run migrate once with the direct URL
  first, or keep using direct for both until you need pooling.

## Wire local env (optional)

Point the API at Supabase instead of Docker Postgres:

```bash
# .env (gitignored) — do not commit
DATABASE_URL='postgres://postgres:SECRET@db.<PROJECT_REF>.supabase.co:5432/postgres?sslmode=require'
```

Or keep local Postgres:

```bash
DATABASE_URL='postgres://webcast:webcast@localhost:5432/webcast?sslmode=disable'
```

`docker-compose.yml` Postgres remains for offline / default local work.

## Cloud Run / deploy

1. Copy secrets file:

   ```bash
   cp deploy/cloudrun.env.example deploy/cloudrun.env
   # set DATABASE_URL to the Supabase direct URI (sslmode=require)
   ```

2. Deploy:

   ```bash
   ./deploy/cloudrun-deploy.sh
   ```

   The script already passes `DATABASE_URL` into Cloud Run `--set-env-vars`.
   CI can export the same vars (GitHub Actions secrets) without a local
   `cloudrun.env`; see `.github/workflows/cloudrun-deploy.yml`.

3. Leave `CLOUD_SQL_INSTANCE` unset when using Supabase (no Cloud SQL sidecar).

### GitHub secret

Repo maintainers with Actions secrets permission:

```bash
# Paste the real URI when prompted (never echo it into shell history from a file if avoidable)
gh secret set DATABASE_URL -R netesh3/webinar
```

Also set `SESSION_SECRET` and LiveKit secrets the same way. Contributors without
admin on `netesh3/webinar` will get HTTP 403 — ask a maintainer.

## Apply migrations once (recommended before first traffic)

```bash
# Uses api/cmd/migrate — same embedded SQL as server boot
make migrate DB_URL='postgres://postgres:SECRET@db.<PROJECT_REF>.supabase.co:5432/postgres?sslmode=require'
# or: cd api && DATABASE_URL='…' go run ./cmd/migrate
```

Idempotent: already-applied versions are skipped. The API will migrate again on
boot if anything is pending.

## Checklist

- [ ] `supabase login` (or Dashboard project exists)
- [ ] Project created / reused (`webcast` / `webinar`)
- [ ] `DATABASE_URL` with `sslmode=require` (direct for migrate)
- [ ] `make migrate` succeeds against Supabase
- [ ] `deploy/cloudrun.env` or GitHub secret `DATABASE_URL` set
- [ ] Cloud Run deploy; API healthy; tables visible in Supabase Table Editor
