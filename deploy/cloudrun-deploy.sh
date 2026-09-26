#!/usr/bin/env bash
# Build the API image, push to Artifact Registry, deploy Cloud Run.
#
# Does not invent secrets. Provide them via:
#   - deploy/cloudrun.env (copy from cloudrun.env.example; gitignored), or
#   - already-exported env vars (CI: map GitHub Actions secrets into the job env)
#
# If DATABASE_URL and SESSION_SECRET are already set, the env file is optional
# (CI path). Otherwise the file is required.
#
# Usage:
#   ./deploy/cloudrun-deploy.sh              # build + push + deploy
#   ./deploy/cloudrun-deploy.sh --build-only # image only
#   ./deploy/cloudrun-deploy.sh --dry-run    # print planned gcloud commands

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/deploy/cloudrun.env"
EXAMPLE="${ROOT}/deploy/cloudrun.env.example"

PROJECT="${GCP_PROJECT:-selfreminder-rnix}"
REGION="${GCP_REGION:-asia-south1}"
AR_REPO="${AR_REPO:-webcast}"
SERVICE="${SERVICE_NAME:-webcast-api}"
IMAGE_NAME="${IMAGE_NAME:-webcast-api}"

BUILD_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --build-only) BUILD_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '+'; printf ' %q' "$@"; echo
  else
    "$@"
  fi
}

load_env() {
  # CI / pre-exported secrets: skip file so we never clobber them.
  if [[ -n "${DATABASE_URL:-}" && -n "${SESSION_SECRET:-}" ]]; then
    :
  elif [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
  else
    echo "missing $ENV_FILE and required env — copy from $EXAMPLE or export DATABASE_URL / SESSION_SECRET / LIVEKIT_*" >&2
    exit 1
  fi

  # Optional: merge non-secret defaults from the example file when running in CI
  # with only secrets set. Operators can still export GCP_* in the workflow.
  PROJECT="${GCP_PROJECT:-$PROJECT}"
  REGION="${GCP_REGION:-$REGION}"
  AR_REPO="${AR_REPO:-$AR_REPO}"
  SERVICE="${SERVICE_NAME:-$SERVICE}"
  IMAGE_NAME="${IMAGE_NAME:-$IMAGE_NAME}"
}

require() {
  local k="$1"
  if [[ -z "${!k:-}" ]]; then
    echo "required value $k is empty (set in $ENV_FILE or the environment)" >&2
    exit 1
  fi
}

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${IMAGE_NAME}:$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo latest)"

echo "project=$PROJECT region=$REGION image=$IMAGE"

run gcloud config set project "$PROJECT" --quiet
run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# --suppress-logs: CI deploy SAs often lack permission to stream the default
# Cloud Build log bucket; the build itself still runs. Status is returned either way.
run gcloud builds submit "$ROOT/api" \
  --tag "$IMAGE" \
  --project "$PROJECT" \
  --suppress-logs

if [[ "$BUILD_ONLY" -eq 1 ]]; then
  echo "build-only: image pushed as $IMAGE"
  exit 0
fi

load_env
require DATABASE_URL
require SESSION_SECRET

# LiveKit: either LIVEKIT_PROJECTS or legacy trio.
if [[ -z "${LIVEKIT_PROJECTS:-}" ]]; then
  require LIVEKIT_URL
  require LIVEKIT_API_KEY
  require LIVEKIT_API_SECRET
fi

ENV_VARS=(
  "APP_ENV=${APP_ENV:-production}"
  "COOKIE_SECURE=${COOKIE_SECURE:-true}"
  "RECORDINGS_ENABLED=${RECORDINGS_ENABLED:-true}"
  "RECORDINGS_DIR=${RECORDINGS_DIR:-/tmp/recordings}"
  "SEED_DEV=${SEED_DEV:-false}"
  "TELEMETRY_ENABLED=${TELEMETRY_ENABLED:-false}"
  "DATABASE_URL=${DATABASE_URL}"
  "SESSION_SECRET=${SESSION_SECRET}"
)

if [[ -n "${LIVEKIT_PROJECTS:-}" ]]; then
  ENV_VARS+=("LIVEKIT_PROJECTS=${LIVEKIT_PROJECTS}")
else
  ENV_VARS+=("LIVEKIT_URL=${LIVEKIT_URL}")
  ENV_VARS+=("LIVEKIT_API_KEY=${LIVEKIT_API_KEY}")
  ENV_VARS+=("LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}")
  [[ -n "${LIVEKIT_HTTP_URL:-}" ]] && ENV_VARS+=("LIVEKIT_HTTP_URL=${LIVEKIT_HTTP_URL}")
fi

[[ -n "${CORS_ORIGINS:-}" ]] && ENV_VARS+=("CORS_ORIGINS=${CORS_ORIGINS}")
[[ -n "${WEB_BASE_URL:-}" ]] && ENV_VARS+=("WEB_BASE_URL=${WEB_BASE_URL}")
[[ -n "${APP_NAME:-}" ]] && ENV_VARS+=("APP_NAME=${APP_NAME}")
# Bootstrap admin on fresh DB (EnsureAdminAccount + PromoteAdmins at API boot).
[[ -n "${ADMIN_EMAILS:-}" ]] && ENV_VARS+=("ADMIN_EMAILS=${ADMIN_EMAILS}")
[[ -n "${ADMIN_PASSWORD:-}" ]] && ENV_VARS+=("ADMIN_PASSWORD=${ADMIN_PASSWORD}")
# Supabase Auth (Google). All three required for Continue with Google.
[[ -n "${SUPABASE_URL:-}" ]] && ENV_VARS+=("SUPABASE_URL=${SUPABASE_URL}")
[[ -n "${SUPABASE_ANON_KEY:-}" ]] && ENV_VARS+=("SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}")
[[ -n "${SUPABASE_JWT_SECRET:-}" ]] && ENV_VARS+=("SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}")
# Public Web client ID → /api/config googleClientId (One Tap + Drive Picker).
[[ -n "${GOOGLE_CLIENT_ID:-}" ]] && ENV_VARS+=("GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}")
[[ -n "${GOOGLE_API_KEY:-}" ]] && ENV_VARS+=("GOOGLE_API_KEY=${GOOGLE_API_KEY}")
[[ -n "${GOOGLE_CLIENT_SECRET:-}" ]] && ENV_VARS+=("GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}")
# Connect WhatsApp (Meta Embedded Signup). config.go refuses to boot on a partial
# set — app id, app secret and Embedded Signup config id, or none of the three —
# so a half-filled environment here fails at container start rather than leaving a
# Connect button that dies after the host has already granted access.
[[ -n "${META_APP_ID:-}" ]] && ENV_VARS+=("META_APP_ID=${META_APP_ID}")
[[ -n "${META_APP_SECRET:-}" ]] && ENV_VARS+=("META_APP_SECRET=${META_APP_SECRET}")
[[ -n "${META_WHATSAPP_CONFIG_ID:-}" ]] && ENV_VARS+=("META_WHATSAPP_CONFIG_ID=${META_WHATSAPP_CONFIG_ID}")
[[ -n "${META_WEBHOOK_VERIFY_TOKEN:-}" ]] && ENV_VARS+=("META_WEBHOOK_VERIFY_TOKEN=${META_WEBHOOK_VERIFY_TOKEN}")
# Recording storage. "disk" needs nothing further; "s3" (an S3-compatible
# bucket — Backblaze B2 in practice) needs all five below. config.go refuses
# to boot with RECORDINGS_ENABLED=true and RECORDINGS_BACKEND=s3 if any are
# missing, so an incomplete set here fails at container start, not silently.
[[ -n "${RECORDINGS_BACKEND:-}" ]] && ENV_VARS+=("RECORDINGS_BACKEND=${RECORDINGS_BACKEND}")
[[ -n "${RECORDINGS_S3_BUCKET:-}" ]] && ENV_VARS+=("RECORDINGS_S3_BUCKET=${RECORDINGS_S3_BUCKET}")
[[ -n "${RECORDINGS_S3_ENDPOINT:-}" ]] && ENV_VARS+=("RECORDINGS_S3_ENDPOINT=${RECORDINGS_S3_ENDPOINT}")
[[ -n "${RECORDINGS_S3_REGION:-}" ]] && ENV_VARS+=("RECORDINGS_S3_REGION=${RECORDINGS_S3_REGION}")
[[ -n "${RECORDINGS_S3_ACCESS_KEY:-}" ]] && ENV_VARS+=("RECORDINGS_S3_ACCESS_KEY=${RECORDINGS_S3_ACCESS_KEY}")
[[ -n "${RECORDINGS_S3_SECRET_KEY:-}" ]] && ENV_VARS+=("RECORDINGS_S3_SECRET_KEY=${RECORDINGS_S3_SECRET_KEY}")
[[ -n "${RECORDINGS_MODE:-}" ]] && ENV_VARS+=("RECORDINGS_MODE=${RECORDINGS_MODE}")
[[ -n "${RECORDINGS_EGRESS_TEMPLATE_URL:-}" ]] && ENV_VARS+=("RECORDINGS_EGRESS_TEMPLATE_URL=${RECORDINGS_EGRESS_TEMPLATE_URL}")
[[ -n "${RECORDINGS_EGRESS_PRESET:-}" ]] && ENV_VARS+=("RECORDINGS_EGRESS_PRESET=${RECORDINGS_EGRESS_PRESET}")
[[ -n "${RECORDINGS_CDN_BASE_URL:-}" ]] && ENV_VARS+=("RECORDINGS_CDN_BASE_URL=${RECORDINGS_CDN_BASE_URL}")
[[ -n "${BROADCAST_RTMP_BASE:-}" ]] && ENV_VARS+=("BROADCAST_RTMP_BASE=${BROADCAST_RTMP_BASE}")
[[ -n "${BROADCAST_HLS_BASE:-}" ]] && ENV_VARS+=("BROADCAST_HLS_BASE=${BROADCAST_HLS_BASE}")
[[ -n "${RECORDINGS_RETENTION_DAYS:-}" ]] && ENV_VARS+=("RECORDINGS_RETENTION_DAYS=${RECORDINGS_RETENTION_DAYS}")
[[ -n "${EMPTY_ROOM_CLOSE_MIN:-}" ]] && ENV_VARS+=("EMPTY_ROOM_CLOSE_MIN=${EMPTY_ROOM_CLOSE_MIN}")
# Turns on POST /api/internal/tick, which Cloud Scheduler calls every minute so that
# reminders, drips and meeting limits run while the service is scaled to zero. See
# deploy/cloud-scheduler-tick.sh, which needs the same value.
[[ -n "${TICK_SECRET:-}" ]] && ENV_VARS+=("TICK_SECRET=${TICK_SECRET}")
[[ -n "${SUPPORT_EMAIL:-}" ]] && ENV_VARS+=("SUPPORT_EMAIL=${SUPPORT_EMAIL}")
[[ -n "${SMTP_HOST:-}" ]] && ENV_VARS+=("SMTP_HOST=${SMTP_HOST}")
[[ -n "${SMTP_PORT:-}" ]] && ENV_VARS+=("SMTP_PORT=${SMTP_PORT}")
[[ -n "${SMTP_USERNAME:-}" ]] && ENV_VARS+=("SMTP_USERNAME=${SMTP_USERNAME}")
[[ -n "${SMTP_PASSWORD:-}" ]] && ENV_VARS+=("SMTP_PASSWORD=${SMTP_PASSWORD}")
[[ -n "${SMTP_FROM:-}" ]] && ENV_VARS+=("SMTP_FROM=${SMTP_FROM}")

# Write YAML for --env-vars-file so values may contain commas (e.g. CORS_ORIGINS
# with multiple origins). Comma-joined --set-env-vars breaks on those values.
ENV_YAML="$(mktemp)"
cleanup_env_yaml() { rm -f "$ENV_YAML"; }
trap cleanup_env_yaml EXIT

{
  for entry in "${ENV_VARS[@]}"; do
    key="${entry%%=*}"
    val="${entry#*=}"
    # JSON-encode the value so YAML stays valid for quotes, newlines, etc.
    quoted="$(printf '%s' "$val" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    printf '%s: %s\n' "$key" "$quoted"
  done
} >"$ENV_YAML"

# IMPORTANT: --env-vars-file / --set-env-vars replaces the *entire* env map on
# the new revision. Never run a one-off `gcloud run services update --set-env-vars
# CORS=…` for a partial change — that wiped LIVEKIT_* / DATABASE_URL on revision
# 00014 and crashed the container. Use this script (full set) or `--update-env-vars`.
DEPLOY_ARGS=(
  gcloud run deploy "$SERVICE"
  --image "$IMAGE"
  --region "$REGION"
  --project "$PROJECT"
  --platform managed
  --allow-unauthenticated
  --port 8080
  # 1Gi / 1 CPU is enough for this Go API (tokens, CRUD, CRM). 2Gi/2 was
  # over-provisioned; Cloud Run rejects 2 CPU below ~2Gi anyway.
  --memory "${MEMORY:-1Gi}"
  --cpu "${CPU:-1}"
  --cpu-boost
  --timeout 3600
  # Scale to zero when idle (cost). Cold start can take several seconds; the
  # Workers middleware identity lookup allows ~8s so a signed-in host is not
  # bounced to login on the first hit after idle. Override with MIN_INSTANCES=1
  # if you need always-warm.
  #
  # DB pool is sized to share Supabase's 15-client ceiling across instances
  # (see store.Open). Raising max-instances means revisiting DB_MAX_CONNS so
  # instances * DB_MAX_CONNS stays under that ceiling.
  --min-instances "${MIN_INSTANCES:-0}"
  --max-instances "${MAX_INSTANCES:-3}"
  --env-vars-file "$ENV_YAML"
)

if [[ -n "${CLOUD_SQL_INSTANCE:-}" ]]; then
  DEPLOY_ARGS+=(--add-cloudsql-instances "$CLOUD_SQL_INSTANCE")
fi

run "${DEPLOY_ARGS[@]}"

echo "deployed $SERVICE — check: gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format='value(status.url)'"
