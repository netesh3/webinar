#!/usr/bin/env bash
# Dump public schema from the current Supabase project and restore into the Pro
# project. Does not switch Cloud Run or GitHub secrets — print those steps after.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/supabase-cutover.env}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_DIR:-$ROOT/backups/supabase-$STAMP}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing $ENV_FILE — copy deploy/supabase-cutover.env.example" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a && source "$ENV_FILE" && set +a

require() {
  local n="$1"
  if [[ -z "${!n:-}" ]]; then
    echo "$n is empty in $ENV_FILE" >&2
    exit 1
  fi
}
require SRC_DATABASE_URL
require DST_DATABASE_URL

for bin in pg_dump pg_restore psql; do
  if ! command -v "$bin" >/dev/null; then
    echo "need $bin on PATH (brew install libpq && brew link --force libpq)" >&2
    exit 1
  fi
done

mkdir -p "$OUT_DIR"
DUMP="$OUT_DIR/public.dump"
echo "dumping public → $DUMP"

# App tables only. Auth users are not in public; Google login links by email
# after the new project's Auth is configured (see deploy/SUPABASE.md).
pg_dump "$SRC_DATABASE_URL" \
  --schema=public \
  --no-owner \
  --no-acl \
  --format=custom \
  --file="$DUMP"

echo "source row counts:"
psql "$SRC_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT 'users' t, count(*) FROM users
UNION ALL SELECT 'webinars', count(*) FROM webinars
UNION ALL SELECT 'crm_contacts', count(*) FROM crm_contacts
UNION ALL SELECT 'crm_messages', count(*) FROM crm_messages
ORDER BY 1;
"

echo
echo "About to REPLACE public schema on the DESTINATION."
echo "Destination: ${DST_DATABASE_URL%%@*}@…"
if [[ "${CONFIRM:-}" == "MIGRATE" ]]; then
  ok=MIGRATE
else
  read -r -p "Type MIGRATE to continue: " ok
fi
if [[ "$ok" != "MIGRATE" ]]; then
  echo "aborted"
  exit 1
fi

echo "restoring…"
# --clean drops dest objects that exist in the dump. Fresh Pro public is empty
# enough that this is the right shape.
pg_restore \
  --dbname="$DST_DATABASE_URL" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  --exit-on-error \
  "$DUMP"

echo "re-lock PostgREST (idempotent):"
psql "$DST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/api/internal/store/migrations/0014_lock_postgrest.sql"

echo "destination row counts:"
psql "$DST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT 'users' t, count(*) FROM users
UNION ALL SELECT 'webinars', count(*) FROM webinars
UNION ALL SELECT 'crm_contacts', count(*) FROM crm_contacts
UNION ALL SELECT 'crm_messages', count(*) FROM crm_messages
ORDER BY 1;
"

cat <<EOF

Dump kept at $DUMP

Next (cutover — not done by this script):
  1. New project → Auth → Google: same Web client as now.
     Redirect: ${DST_SUPABASE_URL:-https://<NEW_REF>.supabase.co}/auth/v1/callback
     Add that URI on the Google Cloud OAuth client too.
     Site URL + redirect URLs: https://webinarliv.com/auth/callback (and www / workers.dev).
  2. GitHub secrets (netesh3/webinar):
       DATABASE_URL          = session pooler URI of the NEW project
       SUPABASE_URL          = $DST_SUPABASE_URL
       SUPABASE_ANON_KEY     = (new anon key)
       SUPABASE_JWT_SECRET   = (only if the new project is HS256)
  3. Redeploy Cloud Run (workflow dispatch or ./deploy/cloudrun-deploy.sh).
  4. Confirm GET /api/config shows the new supabaseUrl, then Google login once.
  5. Leave webcast-in read-only / paused until you are sure.

EOF
