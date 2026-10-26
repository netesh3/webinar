#!/usr/bin/env bash
# Restore a webinarliv database dump (docs/BACKUPS.md) into a Postgres you name, then print row
# counts of the key tables as a sanity check.
#
#   scripts/db-restore.sh DUMP TARGET_URL
#
# DUMP is a db-backups/... file (fetch the newest with: go run ./api/cmd/dbbackup latest x.dump).
# TARGET_URL is a scratch or new database: the restore creates tables and fails on existing
# ones, so it never overwrites a live database by accident. It needs pgvector available on the
# target (pgvector/pgvector:pg17 locally, any Supabase or managed Postgres in production).
#
# The dump is the public schema with the vector and pgcrypto extensions; on Supabase those live
# in an "extensions" schema, so it is created first if missing.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 DUMP TARGET_URL" >&2
  exit 2
fi
dump=$1
target=$2
[ -f "$dump" ] || { echo "no such dump: $dump" >&2; exit 2; }

# Supabase resolves the extension types (vector) through search_path = public, extensions; a
# plain Postgres needs the same, or the app's unqualified vector queries fail after a restore.
psql "$target" -X -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
END $$;
SQL

# A public-schema dump carries CREATE SCHEMA public (and its comment), which every new
# database already has: drop just those two entries from the restore list, or
# --exit-on-error stops at the first statement.
list=$(mktemp)
trap 'rm -f "$list"' EXIT
pg_restore --list "$dump" | grep -v -E '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA|COMMENT) - (SCHEMA )?public ' > "$list"

# --no-owner/--no-acl: the target's roles are not production's. --exit-on-error: a partial
# restore must not look like a good one.
pg_restore --dbname="$target" --no-owner --no-acl --exit-on-error --use-list="$list" "$dump"

echo "Restored. Row counts:"
psql "$target" -X -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
SELECT 'users' AS "table", count(*) FROM public.users
UNION ALL SELECT 'webinars', count(*) FROM public.webinars
UNION ALL SELECT 'registrations', count(*) FROM public.registrations
UNION ALL SELECT 'attendance', count(*) FROM public.attendance
UNION ALL SELECT 'schema_migrations', count(*) FROM public.schema_migrations;
SQL
