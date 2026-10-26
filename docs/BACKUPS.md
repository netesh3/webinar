# Database backups

Production Postgres is Supabase, on the **Free plan since 2026-10-26**. The Free plan keeps
**no backups** and caps the database at **500 MB** (past that it goes read-only). We cover both
ourselves:

| What | Where | When |
|---|---|---|
| Nightly logical backup to R2 | [`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml) | 21:30 UTC (03:00 IST), and on demand |
| Restore test into a throwaway Postgres | [`.github/workflows/db-restore-test.yml`](../.github/workflows/db-restore-test.yml) | Sundays 03:00 UTC, and on demand |
| Database size metric and the 300 MB alert | `webinarliv_db_size_bytes` (API) → Grafana, [observability](observability.md#database-size-and-backups) | every 5 minutes |
| "No backup for 30 hours" alert | `webinarliv_db_backup_last_success_seconds` (workflow) → Grafana | after each backup |

## What a backup is

`pg_dump --format=custom --compress=9 --schema=public --extension=vector --extension=pgcrypto
--no-owner --no-acl`, run in the official `postgres:<major>` image of the **server's** major
version (the workflow reads `server_version_num` first; pg_dump must not be older than the
server). At our size (37 MB on 2026-10-26) a dump is well under a megabyte compressed and
takes seconds.

- **Included:** everything in `public` (every table the app owns, `schema_migrations`), plus
  the `vector` and `pgcrypto` extensions it uses.
- **Not included:** Supabase's own schemas (`auth`, `storage`, `realtime`, …). Supabase Auth
  only brokers Google sign-in (`api/internal/api/auth.go`); our accounts are `public.users`,
  and nothing in `public` references `auth.*`. After a restore into a new Supabase project,
  Google sign-in works once `SUPABASE_*` points at it: people sign in again and land on their
  existing account by email.

The connection is the `DATABASE_URL` secret, the Supabase **:5432 session pooler** URL the API
already uses. pg_dump needs a session, so never the :6543 transaction pooler.

## Where backups live

`db-backups/YYYY/MM/DD/webinarliv-<UTC timestamp>.dump` in the recordings bucket (the
`RECORDINGS_S3_*` secrets), or a bucket of their own if `DB_BACKUP_S3_*` is set (each falls
back to the matching `RECORDINGS_S3_*`). The recordings purge (`api/internal/api/recording_purge.go`)
only matches `ab/cd/<uuid>` takes, `uploads/` and `clips/`, so it never touches `db-backups/`.
The backup tool ([`api/cmd/dbbackup`](../api/cmd/dbbackup/main.go)) lists, reads and deletes
only under `db-backups/`, and only keys in its own format.

**Retention** ([`api/internal/dbbackup`](../api/internal/dbbackup/dbbackup.go), tested):

- every backup of the last **30 days**;
- older, the **first backup of each month for 12 months** (the current month counts);
- the **newest backup, always**, however old (if the job breaks, the last good dump stays);
- nothing that is not a backup key is ever deleted.

## Storage class: Infrequent Access after 30 days

The bucket's lifecycle rules ([`api/internal/r2lifecycle`](../api/internal/r2lifecycle/r2lifecycle.go),
tested) move objects to **R2 Infrequent Access** when they are 30 days old. That covers recording
takes and their manifests, clips, uploaded videos, and the backups here. R2 (checked 2026-10-26):
Standard $0.015/GB-month, Infrequent Access **$0.010**, a **30-day minimum** per object,
**$0.01/GB to read back**, and egress free in both.

**What moves, by prefix** (R2 filters lifecycle rules by key prefix only, at most 1000 rules):

| Prefix | Objects |
|---|---|
| `00/` … `ff/`, 256 rules | recording takes `id[0:2]/id[2:4]/<uuid>.<ext>` plus manifests (the mix recorder uses the same keys). Nothing else in the bucket starts with two lowercase hex characters and a slash. |
| `uploads/` | uploaded videos |
| `clips/` | clip and reel outputs |
| `db-backups/` | these dumps (monthly ones are kept 12 months) |

**What stays Standard:** `covers/`, `avatars/`, `chat/` and `wa/`. They're small and read often.

**Effect on the app:** none in code.
- **Reads:** GETs and range requests on an IA object are the same calls; replays, simulive and
  the Studio play as before. Each GB read back costs $0.01. A 1 h recording (~0.45 GB) replayed
  by 100 viewers is about $0.45.
- **Deletes:** deleting an IA object before its 30 days in IA (recording expiry, a host's delete,
  the recordings purge) is billed for the rest of that minimum. Objects only move at 30 days old,
  so this matters only for a recording deleted between day 30 and day 60.
- **A restore:** reads one dump back, which costs a fraction of a cent.

**Saving:** a third off everything over a month old. At ~300 GB of month-old recordings that's
~$1.50/month ($4.50 → $3.00), growing with the library.

**Credentials:** lifecycle rules are bucket configuration, which R2 refuses (403) to the app's object-scoped key. Create an R2 API token with **Admin Read & Write** (Cloudflare → R2 → Manage API tokens) and store it as the repo secrets `R2_ADMIN_ACCESS_KEY` / `R2_ADMIN_SECRET_KEY`; only this workflow reads them, and without them it falls back to the recordings key and fails on the first call.

**Applying or changing the rules:** run **Actions → Apply R2 lifecycle**. It's a dry run by
default, which prints the rules and changes nothing; untick it to apply. The tool reads the
bucket's rules and keeps every rule it didn't write, including R2's default multipart-abort
rule, because the S3 call replaces the whole set. It then replaces its own `webinarliv-ia-*`
rules, applies the set and reads it back. Running it again changes nothing. R2 moves objects
that already exist within about 24 hours of a change.

## Setting it up

Secrets and variables (names only; set them with `gh secret set NAME -R github.com/netesh3/webinar`
and never paste the values anywhere else):

| Name | Kind | Needed | Notes |
|---|---|---|---|
| `DATABASE_URL` | secret | yes | already set for Deploy API |
| `RECORDINGS_S3_BUCKET`, `_ENDPOINT`, `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY` | secrets | yes | already set for Deploy API |
| `DB_BACKUP_S3_*` (same five suffixes) | secrets | no | only to keep backups in another bucket |
| `OTEL_EXPORTER_OTLP_HEADERS` | secret | for the alert | already set for Deploy API |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | variable | for the alert | already set for Deploy API |

First run: Actions → **DB backup** → Run workflow (or `gh workflow run db-backup.yml -R
github.com/netesh3/webinar`). Then Actions → **DB restore test** → Run workflow, which restores
what was just stored and checks the counts. GitHub emails the workflow's last editor when a
scheduled run fails.

## Restoring

1. Fetch a dump (the newest, or pick a key from `list`):

   ```sh
   cd api
   RECORDINGS_S3_BUCKET=… RECORDINGS_S3_ENDPOINT=… RECORDINGS_S3_ACCESS_KEY=… \
   RECORDINGS_S3_SECRET_KEY=… go run ./cmd/dbbackup latest /tmp/webinarliv.dump
   ```

2. Restore into an **empty** database with pgvector available: a new Supabase project, a managed
   Postgres, or locally `docker run -e POSTGRES_PASSWORD=x -p 5433:5432 pgvector/pgvector:pg17`:

   ```sh
   scripts/db-restore.sh /tmp/webinarliv.dump 'postgres://postgres:x@localhost:5433/postgres'
   ```

   The script creates the `extensions` schema, sets `search_path = "$user", public, extensions`
   (as on Supabase), restores with `--exit-on-error`, and prints row counts of `users`,
   `webinars`, `registrations`, `attendance` and `schema_migrations`. It fails on existing
   tables, so it cannot overwrite a live database by accident.

3. To put it into service: point `DATABASE_URL` (and `SUPABASE_*` for a new Supabase project)
   at it, and run Deploy API. Migrations newer than the dump apply on boot.

Tested 2026-10-26 on Postgres 16 locally: all 170 migrations applied in a Supabase-like
database (extensions in `extensions`), dumped with the workflow's flags, restored with the
script into an empty database: 119 of 119 tables, both extensions, rows intact.
