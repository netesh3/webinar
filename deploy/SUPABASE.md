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
# Prefer Mumbai for this repo's India topology (matches Cloud Run asia-south1).
supabase projects create webcast-in --org-id <ORG_ID> --db-password <STRONG_PASSWORD> --region ap-south-1
```

Dashboard alternative: https://supabase.com/dashboard → New project → name `webcast-in`
(or `webcast`) → region **Mumbai / ap-south-1** → save the database password.

Active managed topology: project **`webcast-in`** (`odptebpbrrixhrzfqtqp`) in `ap-south-1`.  
Deprecated: older `webcast` (`qiakwcylllwwvjymgmtz`) in `us-east-1` — leave until you no longer need a rollback copy.

## Connection strings

Project → **Settings → Database → Connection string**.

| Use | Host / port | Notes |
|---|---|---|
| **Preferred for this app (IPv4)** | Session pooler: `aws-0-<REGION>.pooler.supabase.com:5432` | Full Postgres session. User is `postgres.<PROJECT_REF>`. Use for `make migrate` and Cloud Run. |
| Direct | `db.<PROJECT_REF>.supabase.co:5432` | Often **IPv6-only** on newer projects — fails on IPv4-only networks (many laptops / default Cloud Run egress). |
| Transaction pooler | `:6543` | Add `sslmode=require` and `default_query_exec_mode=simple_protocol` (pgx prepared statements break under transaction pooling). |

Always include **`sslmode=require`**. Supabase rejects non-TLS clients.

Example shapes (passwords redacted — never commit real URLs):

```text
# Session pooler :5432 (recommended — IPv4 + full sessions for migrate/pgx)
postgres://postgres.<PROJECT_REF>:SECRET@aws-0-<REGION>.pooler.supabase.com:5432/postgres?sslmode=require

# Direct (IPv6 on many projects — prefer only if your runtime has IPv6 egress)
postgres://postgres:SECRET@db.<PROJECT_REF>.supabase.co:5432/postgres?sslmode=require

# Transaction pooler (scale-out / many short-lived Cloud Run instances)
postgres://postgres.<PROJECT_REF>:SECRET@aws-0-<REGION>.pooler.supabase.com:6543/postgres?sslmode=require&default_query_exec_mode=simple_protocol
```

Database name is usually `postgres`. That is fine for a dedicated project; the
app creates its own tables via migrations.

### pgx / pool behaviour

- `store.Open` uses a `pgxpool` (MaxConns=20). Session pooler `:5432` is enough for
  Cloud Run `--max-instances 3`.
- Migrations wrap each file in a transaction and record versions in
  `schema_migrations`. Prefer the **session pooler** URL (or direct if IPv6 works).
- Avoid the **transaction** pooler for migrate unless you also set
  `default_query_exec_mode=simple_protocol` for runtime.

## Wire local env (optional)

Point the API at Supabase instead of Docker Postgres:

```bash
# .env (gitignored) — do not commit
DATABASE_URL='postgres://postgres.<PROJECT_REF>:SECRET@aws-0-<REGION>.pooler.supabase.com:5432/postgres?sslmode=require'
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
   # set DATABASE_URL to the Supabase session-pooler URI (sslmode=require)
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
- [ ] Project created / reused (`webcast-in` / `webinar`)
- [ ] `DATABASE_URL` with `sslmode=require` (session pooler for Cloud Run)
- [ ] `make migrate` succeeds against Supabase
- [ ] `deploy/cloudrun.env` or GitHub secret `DATABASE_URL` set
- [ ] Cloud Run deploy; API healthy; tables visible in Supabase Table Editor
- [x] Google sign-in: OAuth client + Supabase Google provider + Auth URLs + Cloud Run
      `SUPABASE_*` (incl. JWT secret); see **Auth — Google via Supabase** below

## Auth — Google via Supabase

The app keeps its own `webcast_session` cookie. Supabase Auth is only used for
the Google OAuth dance; the API verifies the Supabase JWT and issues the same
session password login uses.

### 1. Google Cloud OAuth client

1. [Google Cloud Console](https://console.cloud.google.com/) → **Google Auth Platform →
   Clients** (or APIs & Services → Credentials) → Create credentials → **OAuth
   client ID** → Application type **Web application**.
   You can also reuse the Firebase “Web client (auto created by Google Service)”
   if the project already has one — add the URIs below to that client.
2. Authorized JavaScript origins (optional for this flow): your Worker origin,
   e.g. `https://webinar-web.ganesh-s-p006.workers.dev`, plus
   `http://localhost:3000` for local Next.
3. Authorized redirect URIs — **must** include Supabase’s callback:

   ```text
   https://odptebpbrrixhrzfqtqp.supabase.co/auth/v1/callback
   ```

   (Replace the project ref if you use another Supabase project.)
4. Copy the **Client ID** and **Client secret** into Supabase only (never git).
   Console may hide existing secrets (“Viewing and downloading client secrets is
   no longer available”); use Firebase Identity Toolkit
   `defaultSupportedIdpConfigs/google.com` or rotate/add a secret if needed.

This is separate from `GOOGLE_CLIENT_ID` / `GOOGLE_API_KEY` used for Drive Picker.

**gcloud limits:** classic Web OAuth clients cannot be created via public gcloud for
projects that are not in a Cloud Organization (IAP brand APIs require an org).
Use the Console (or automate the Auth Platform Clients UI). IAM
`gcloud alpha iam oauth-clients` is a different product and is not usable for
Supabase Google sign-in.

### 2. Supabase Dashboard / Management API

Project **webcast-in** (`odptebpbrrixhrzfqtqp`) → Authentication:

1. **Providers → Google** → enable → paste Client ID and Client secret → Save.
   (Management API: `PATCH /v1/projects/<ref>/config/auth` with
   `external_google_enabled`, `external_google_client_id`, `external_google_secret`.)
2. **URL configuration**:
   - Site URL: `https://webinar-web.ganesh-s-p006.workers.dev`
   - Redirect URLs:
     - `https://webinar-web.ganesh-s-p006.workers.dev/auth/callback`
     - `http://localhost:3000/auth/callback` (local Next)
3. **Settings → API**: copy Project URL, `anon` `public` key, and **JWT Secret**
   (legacy symmetric secret used to verify access tokens). Management API:
   `GET /v1/projects/<ref>/postgrest` → `jwt_secret`.

### 3. API / Cloud Run env

Set on Cloud Run (via `deploy/cloudrun.env`, GitHub secrets, or `gcloud`):

| Variable | Public? | Purpose |
|----------|---------|---------|
| `SUPABASE_URL` | yes (via `/api/config`) | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | yes (via `/api/config`) | anon/public key for browser OAuth |
| `SUPABASE_JWT_SECRET` | **no** | verifies access tokens in `POST /api/auth/supabase` |

When all three are set, `/api/config` returns `googleAuth: true` and the login /
signup pages show **Continue with Google**.

### Consent screen / verification (Google Cloud)

Configured under **Google Auth Platform → Audience / Branding** for project
`ai-project-490516`:

| Setting | Typical value for Webcast |
|---------|---------------------------|
| User type | **External** |
| Publishing status | **In production** (or Testing) |
| Scopes used | `openid` `email` `profile` (non-sensitive) |

- **Testing** mode: only allowlisted test users can complete sign-in; add each
  Gmail under Audience → Test users. Cap is usually 100 test users.
- **In production** with only basic scopes: any Google account can sign in; you
  may still see Google’s “unverified app” interstitial until brand verification
  if you later request sensitive/restricted scopes.
- Lifetime **OAuth user cap** (shown as e.g. `0 / 100`) applies when requesting
  *unapproved* sensitive/restricted scopes — not for the basic login scopes above.
- Brand verification (logo, domain, privacy policy) is manual in Console if Google
  prompts for it; it is not required to finish basic Google login for this app.

### 4. Flow

1. Browser → Supabase `signInWithOAuth({ provider: "google" })` via `@supabase/ssr`
   (PKCE code verifier stored in **cookies**, not memory/localStorage)
2. Google → Supabase → redirect to `/auth/callback?code=…`
3. Frontend exchanges code with the same cookie storage → `POST /api/auth/supabase`
   with `accessToken`
4. API verifies JWT → creates/links `users` row → sets `webcast_session`
5. Host / Admin / My webinars middleware sees the first-party cookie on Workers

Do **not** use a plain `@supabase/supabase-js` client with `persistSession: false`
for this flow — the PKCE verifier will not survive the Google redirect.

Password login remains available. New Google users respect `SIGNUP_OPEN`; existing
email accounts are linked by address.