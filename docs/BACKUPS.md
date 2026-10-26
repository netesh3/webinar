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
