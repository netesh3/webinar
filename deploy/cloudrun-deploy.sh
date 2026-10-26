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

GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo latest)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${IMAGE_NAME}:${GIT_SHA}"

echo "project=$PROJECT region=$REGION image=$IMAGE"

run gcloud config set project "$PROJECT" --quiet
run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# --suppress-logs: CI deploy SAs often lack permission to stream the default
# Cloud Build log bucket; the build itself still runs. Status is returned either way.
#
# --machine-type: the default Cloud Build worker has a single vCPU, and compiling the
# API (LiveKit, pion, pgx) was most of a ~4 minute build. An 8-vCPU worker builds it
# in a fraction of that for a few cents more per deploy.
run gcloud builds submit "$ROOT/api" \
  --tag "$IMAGE" \
  --project "$PROJECT" \
  --machine-type=e2-highcpu-8 \
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
  # AV1 kill switch read by every browser via /api/config: off | meetings | on.
  "AV1_PUBLISH=${AV1_PUBLISH:-off}"
  "DATABASE_URL=${DATABASE_URL}"
  "SESSION_SECRET=${SESSION_SECRET}"
  # The boot budget check (api/internal/store/dbconfig.go) needs to know how many
  # instances can exist; same number as --max-instances below.
  "DB_BUDGET_MAX_INSTANCES=${MAX_INSTANCES:-3}"
)

# Database connection routing and pool knobs. All optional; unset keeps the
# defaults in api/internal/store/dbconfig.go. DATABASE_LISTEN_URL is the
# session-mode URL for LISTEN + migrations when DATABASE_URL is the transaction
# pooler (see deploy/SUPABASE.md "Connection budget").
for v in DATABASE_LISTEN_URL DATABASE_POOL_MODE DB_QUERY_EXEC_MODE DB_MAX_CONNS DB_MIN_CONNS \
  DB_MAX_CONN_IDLE_TIME DB_MAX_CONN_LIFETIME DB_HEALTH_CHECK_PERIOD DB_CONNECT_TIMEOUT DB_POOLER_POOL_SIZE; do
  if [[ -n "${!v:-}" ]]; then ENV_VARS+=("${v}=${!v}"); fi
done

# The legacy trio goes through whenever it is set, LIVEKIT_PROJECTS or not: a "default" entry
# in the list that leaves out url/key/secret takes them from these (api/internal/config).
# Passing only the list made that entry boot-fail with "url is required" (2026-10-19).
[[ -n "${LIVEKIT_PROJECTS:-}" ]] && ENV_VARS+=("LIVEKIT_PROJECTS=${LIVEKIT_PROJECTS}")
[[ -n "${LIVEKIT_URL:-}" ]] && ENV_VARS+=("LIVEKIT_URL=${LIVEKIT_URL}")
[[ -n "${LIVEKIT_API_KEY:-}" ]] && ENV_VARS+=("LIVEKIT_API_KEY=${LIVEKIT_API_KEY}")
[[ -n "${LIVEKIT_API_SECRET:-}" ]] && ENV_VARS+=("LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}")
[[ -n "${LIVEKIT_HTTP_URL:-}" ]] && ENV_VARS+=("LIVEKIT_HTTP_URL=${LIVEKIT_HTTP_URL}")

[[ -n "${CORS_ORIGINS:-}" ]] && ENV_VARS+=("CORS_ORIGINS=${CORS_ORIGINS}")
[[ -n "${WEB_BASE_URL:-}" ]] && ENV_VARS+=("WEB_BASE_URL=${WEB_BASE_URL}")
[[ -n "${APP_NAME:-}" ]] && ENV_VARS+=("APP_NAME=${APP_NAME}")
# Bootstrap admin on fresh DB (EnsureAdminAccount + PromoteAdmins at API boot).
[[ -n "${ADMIN_EMAILS:-}" ]] && ENV_VARS+=("ADMIN_EMAILS=${ADMIN_EMAILS}")
[[ -n "${ADMIN_PASSWORD:-}" ]] && ENV_VARS+=("ADMIN_PASSWORD=${ADMIN_PASSWORD}")
# Supabase Auth (Google). URL + anon key required for Continue with Google.
# PROJECT_URL is the *.supabase.co origin when SUPABASE_URL is a custom domain.
[[ -n "${SUPABASE_URL:-}" ]] && ENV_VARS+=("SUPABASE_URL=${SUPABASE_URL}")
[[ -n "${SUPABASE_PROJECT_URL:-}" ]] && ENV_VARS+=("SUPABASE_PROJECT_URL=${SUPABASE_PROJECT_URL}")
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
[[ -n "${MEDIA_QUOTA_DEFAULT_MB:-}" ]] && ENV_VARS+=("MEDIA_QUOTA_DEFAULT_MB=${MEDIA_QUOTA_DEFAULT_MB}")
[[ -n "${EMPTY_ROOM_CLOSE_MIN:-}" ]] && ENV_VARS+=("EMPTY_ROOM_CLOSE_MIN=${EMPTY_ROOM_CLOSE_MIN}")
# Edge delivery (docs/edge-delivery.md); each unset keeps the API's default.
[[ -n "${EDGE_PLAYBACK_BASE:-}" ]] && ENV_VARS+=("EDGE_PLAYBACK_BASE=${EDGE_PLAYBACK_BASE}")
[[ -n "${OPS_ALERT_EMAILS:-}" ]] && ENV_VARS+=("OPS_ALERT_EMAILS=${OPS_ALERT_EMAILS}")
[[ -n "${EDGE_NEAR_COUNTRIES:-}" ]] && ENV_VARS+=("EDGE_NEAR_COUNTRIES=${EDGE_NEAR_COUNTRIES}")
[[ -n "${EDGE_DEBUG_CLOCK:-}" ]] && ENV_VARS+=("EDGE_DEBUG_CLOCK=${EDGE_DEBUG_CLOCK}")
[[ -n "${DEBUG_GOROUTINES:-}" ]] && ENV_VARS+=("DEBUG_GOROUTINES=${DEBUG_GOROUTINES}")
[[ -n "${EDGE_ENCODING_WIDTH:-}" ]] && ENV_VARS+=("EDGE_ENCODING_WIDTH=${EDGE_ENCODING_WIDTH}")
[[ -n "${EDGE_ENCODING_HEIGHT:-}" ]] && ENV_VARS+=("EDGE_ENCODING_HEIGHT=${EDGE_ENCODING_HEIGHT}")
[[ -n "${EDGE_ENCODING_FPS:-}" ]] && ENV_VARS+=("EDGE_ENCODING_FPS=${EDGE_ENCODING_FPS}")
[[ -n "${EDGE_VIDEO_BITRATE_KBPS:-}" ]] && ENV_VARS+=("EDGE_VIDEO_BITRATE_KBPS=${EDGE_VIDEO_BITRATE_KBPS}")
[[ -n "${EDGE_AUDIO_BITRATE_KBPS:-}" ]] && ENV_VARS+=("EDGE_AUDIO_BITRATE_KBPS=${EDGE_AUDIO_BITRATE_KBPS}")
[[ -n "${EDGE_H264_PROFILE:-}" ]] && ENV_VARS+=("EDGE_H264_PROFILE=${EDGE_H264_PROFILE}")
# Turns on POST /api/internal/tick, which Cloud Scheduler calls every minute so that
# reminders, drips and meeting limits run while the service is scaled to zero. See
# deploy/cloud-scheduler-tick.sh, which needs the same value.
[[ -n "${TICK_SECRET:-}" ]] && ENV_VARS+=("TICK_SECRET=${TICK_SECRET}")
# Server-side live captions (deploy/captions): the caption agent's shared secret. Unset, the
# host's Captions button keeps using on-device captions.
[[ -n "${CAPTIONS_SECRET:-}" ]] && ENV_VARS+=("CAPTIONS_SECRET=${CAPTIONS_SECRET}")
[[ -n "${CAPTIONS_AGENT_NAME:-}" ]] && ENV_VARS+=("CAPTIONS_AGENT_NAME=${CAPTIONS_AGENT_NAME}")
# Cloud recording from the edge mix (deploy/livekit-box/mixrec): the mix recorder's shared
# secret. Unset, an edge recording starts a compositor of its own, as before.
[[ -n "${MIXREC_SECRET:-}" ]] && ENV_VARS+=("MIXREC_SECRET=${MIXREC_SECRET}")
[[ -n "${MIXREC_URL:-}" ]] && ENV_VARS+=("MIXREC_URL=${MIXREC_URL}")
# The on-demand DigitalOcean video server (deploy/digitalocean/README.md). DO_API_TOKEN is a
# secret; SFU_BOX_PROJECT turns the manager on; the rest override its defaults.
[[ -n "${DO_API_TOKEN:-}" ]] && ENV_VARS+=("DO_API_TOKEN=${DO_API_TOKEN}")
for v in SFU_BOX_PROJECT SFU_BOX_ALWAYS_ON SFU_BOX_WARM_LEAD SFU_BOX_IDLE_GRACE SFU_BOX_BOOT_TIMEOUT \
  SFU_BOX_MAX_FAILURES SFU_BOX_NAME SFU_BOX_REGION SFU_BOX_SIZE SFU_BOX_SNAPSHOT_TAG SFU_BOX_VOLUME \
  SFU_BOX_RESERVED_IP SFU_BOX_TAGS SFU_BOX_SSH_KEYS SFU_BOX_VPC_UUID SFU_BOX_PARK_DROPLET \
  SFU_BOX_REPO SFU_BOX_REF SFU_BOX_TURN_HOST SFU_BOX_AREA SFU_BOX_CAPACITY SFU_BOX_SLOTS SFU_BOX_POINTS; do
  if [[ -n "${!v:-}" ]]; then ENV_VARS+=("${v}=${!v}"); fi
done
# The captions box made and deleted with it (api/internal/api/captions_box.go). Off unless
# CAPTIONS_BOX_ENABLED=true; the rest override its defaults.
for v in CAPTIONS_BOX_ENABLED CAPTIONS_BOX_SIZE CAPTIONS_BOX_IMAGE CAPTIONS_BOX_NAME CAPTIONS_BOX_TAGS \
  CAPTIONS_BOX_CPUS CAPTIONS_BOX_MAX_ROOMS CAPTIONS_BOX_MODEL CAPTIONS_BOX_API_URL \
  CAPTIONS_BOX_LIVEKIT_URL CAPTIONS_BOX_BOOT_TIMEOUT \
  CAPTIONS_PROVIDER CAPTIONS_FALLBACK_LOCAL CAPTIONS_DEEPGRAM_MODEL CAPTIONS_DEEPGRAM_LANGUAGE; do
  if [[ -n "${!v:-}" ]]; then ENV_VARS+=("${v}=${!v}"); fi
done
# Deepgram's key for live captions (CAPTIONS_PROVIDER=deepgram): to the API, which writes it into
# the captions box's root-only env file at create. Never printed.
[[ -n "${DEEPGRAM_API_KEY:-}" ]] && ENV_VARS+=("DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}")
# Grafana Cloud for the box's Alloy, passed in its user data at create (config.BoxGrafana): all
# five or none. GRAFANA_CLOUD_TOKEN is a secret (a write-only access policy token).
for v in GRAFANA_CLOUD_PROM_URL GRAFANA_CLOUD_PROM_USER GRAFANA_CLOUD_LOKI_URL GRAFANA_CLOUD_LOKI_USER \
  GRAFANA_CLOUD_TOKEN; do
  if [[ -n "${!v:-}" ]]; then ENV_VARS+=("${v}=${!v}"); fi
done
# Web Push (api/internal/push): the VAPID pair and contact. All three or none — the API refuses
# to boot on a partial set. Unset, no notifications are offered or sent.
[[ -n "${VAPID_PUBLIC_KEY:-}" ]] && ENV_VARS+=("VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}")
[[ -n "${VAPID_PRIVATE_KEY:-}" ]] && ENV_VARS+=("VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}")
[[ -n "${VAPID_SUBJECT:-}" ]] && ENV_VARS+=("VAPID_SUBJECT=${VAPID_SUBJECT}")
[[ -n "${SUPPORT_EMAIL:-}" ]] && ENV_VARS+=("SUPPORT_EMAIL=${SUPPORT_EMAIL}")
[[ -n "${SMTP_HOST:-}" ]] && ENV_VARS+=("SMTP_HOST=${SMTP_HOST}")
[[ -n "${SMTP_PORT:-}" ]] && ENV_VARS+=("SMTP_PORT=${SMTP_PORT}")
[[ -n "${SMTP_USERNAME:-}" ]] && ENV_VARS+=("SMTP_USERNAME=${SMTP_USERNAME}")
[[ -n "${SMTP_PASSWORD:-}" ]] && ENV_VARS+=("SMTP_PASSWORD=${SMTP_PASSWORD}")
[[ -n "${SMTP_FROM:-}" ]] && ENV_VARS+=("SMTP_FROM=${SMTP_FROM}")
[[ -n "${INBOX_WEBHOOK_SECRET:-}" ]] && ENV_VARS+=("INBOX_WEBHOOK_SECRET=${INBOX_WEBHOOK_SECRET}")
# Connect Zoom. The API offers Connect only when id, secret, redirect, and
# token key are all set. The webhook secret is separate: unset, the webhook
# route refuses the body and the rest of the API still boots.
# AI for the sales chat and "Write with AI" (api/internal/config/ai.go). All optional;
# unset means the chat hands every visitor to a person. Tried in order — OpenAI first,
# then the free tiers — falling to the next when one fails or runs out. The two caps
# bound the estimated monthly spend (defaults 20 and 2 US dollars).
# AI_PROVIDER (groq|openai) puts one first; unset means groq when GROQ_API_KEY is set
# (2026-10-27), with OpenAI behind it as the fallback and for the embeddings.
[[ -n "${AI_PROVIDERS:-}" ]] && ENV_VARS+=("AI_PROVIDERS=${AI_PROVIDERS}")
[[ -n "${OPENAI_API_KEY:-}" ]] && ENV_VARS+=("OPENAI_API_KEY=${OPENAI_API_KEY}")
[[ -n "${OPENAI_MODEL:-}" ]] && ENV_VARS+=("OPENAI_MODEL=${OPENAI_MODEL}")
# The clip features' model (highlights, reels, hooks, post text); the API defaults to gpt-5-mini.
[[ -n "${AI_MODEL_HIGHLIGHTS:-}" ]] && ENV_VARS+=("AI_MODEL_HIGHLIGHTS=${AI_MODEL_HIGHLIGHTS}")
[[ -n "${AI_MONTHLY_USD:-}" ]] && ENV_VARS+=("AI_MONTHLY_USD=${AI_MONTHLY_USD}")
[[ -n "${AI_HOST_MONTHLY_USD:-}" ]] && ENV_VARS+=("AI_HOST_MONTHLY_USD=${AI_HOST_MONTHLY_USD}")
[[ -n "${CLOUDFLARE_AI_ACCOUNT_ID:-}" ]] && ENV_VARS+=("CLOUDFLARE_AI_ACCOUNT_ID=${CLOUDFLARE_AI_ACCOUNT_ID}")
[[ -n "${CLOUDFLARE_AI_TOKEN:-}" ]] && ENV_VARS+=("CLOUDFLARE_AI_TOKEN=${CLOUDFLARE_AI_TOKEN}")
[[ -n "${CLOUDFLARE_AI_MODEL:-}" ]] && ENV_VARS+=("CLOUDFLARE_AI_MODEL=${CLOUDFLARE_AI_MODEL}")
[[ -n "${GROQ_API_KEY:-}" ]] && ENV_VARS+=("GROQ_API_KEY=${GROQ_API_KEY}")
[[ -n "${GROQ_MODEL:-}" ]] && ENV_VARS+=("GROQ_MODEL=${GROQ_MODEL}")
[[ -n "${AI_PROVIDER:-}" ]] && ENV_VARS+=("AI_PROVIDER=${AI_PROVIDER}")
[[ -n "${AI_GROQ_MODEL_QUALITY:-}" ]] && ENV_VARS+=("AI_GROQ_MODEL_QUALITY=${AI_GROQ_MODEL_QUALITY}")
[[ -n "${AI_GROQ_MODEL_FAST:-}" ]] && ENV_VARS+=("AI_GROQ_MODEL_FAST=${AI_GROQ_MODEL_FAST}")
[[ -n "${OPENROUTER_API_KEY:-}" ]] && ENV_VARS+=("OPENROUTER_API_KEY=${OPENROUTER_API_KEY}")
[[ -n "${OPENROUTER_MODEL:-}" ]] && ENV_VARS+=("OPENROUTER_MODEL=${OPENROUTER_MODEL}")
# Razorpay — self-serve plans. Key id and secret together or neither (config.go
# refuses a partial set). The webhook secret is optional; without it only the
# browser's own callback fulfils an order.
[[ -n "${RAZORPAY_KEY_ID:-}" ]] && ENV_VARS+=("RAZORPAY_KEY_ID=${RAZORPAY_KEY_ID}")
[[ -n "${RAZORPAY_KEY_SECRET:-}" ]] && ENV_VARS+=("RAZORPAY_KEY_SECRET=${RAZORPAY_KEY_SECRET}")
[[ -n "${RAZORPAY_WEBHOOK_SECRET:-}" ]] && ENV_VARS+=("RAZORPAY_WEBHOOK_SECRET=${RAZORPAY_WEBHOOK_SECRET}")
[[ -n "${TRIAL_HASH_SALT:-}" ]] && ENV_VARS+=("TRIAL_HASH_SALT=${TRIAL_HASH_SALT}")
[[ -n "${BILLING_GST_PERCENT:-}" ]] && ENV_VARS+=("BILLING_GST_PERCENT=${BILLING_GST_PERCENT}")
[[ -n "${ZOOM_CLIENT_ID:-}" ]] && ENV_VARS+=("ZOOM_CLIENT_ID=${ZOOM_CLIENT_ID}")
[[ -n "${ZOOM_CLIENT_SECRET:-}" ]] && ENV_VARS+=("ZOOM_CLIENT_SECRET=${ZOOM_CLIENT_SECRET}")
[[ -n "${ZOOM_REDIRECT_URL:-}" ]] && ENV_VARS+=("ZOOM_REDIRECT_URL=${ZOOM_REDIRECT_URL}")
[[ -n "${ZOOM_TOKEN_KEY:-}" ]] && ENV_VARS+=("ZOOM_TOKEN_KEY=${ZOOM_TOKEN_KEY}")
[[ -n "${ZOOM_WEBHOOK_SECRET:-}" ]] && ENV_VARS+=("ZOOM_WEBHOOK_SECRET=${ZOOM_WEBHOOK_SECRET}")
[[ -n "${WELCOME_EMAIL:-}" ]] && ENV_VARS+=("WELCOME_EMAIL=${WELCOME_EMAIL}")
[[ -n "${CONTACT_EMAIL:-}" ]] && ENV_VARS+=("CONTACT_EMAIL=${CONTACT_EMAIL}")
[[ -n "${CONTACT_PHONE:-}" ]] && ENV_VARS+=("CONTACT_PHONE=${CONTACT_PHONE}")
# OpenTelemetry to Grafana Cloud (api/internal/observe). Nothing is passed, so telemetry
# stays off, until OTEL_EXPORTER_OTLP_ENDPOINT is set. OTEL_EXPORTER_OTLP_HEADERS carries
# the Grafana credential and is a secret. The resource attributes default to this deploy's
# commit, so a trace says which build served it.
if [[ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]]; then
  ENV_VARS+=("OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}")
  [[ -n "${OTEL_EXPORTER_OTLP_HEADERS:-}" ]] && ENV_VARS+=("OTEL_EXPORTER_OTLP_HEADERS=${OTEL_EXPORTER_OTLP_HEADERS}")
  ENV_VARS+=("OTEL_SERVICE_NAME=${OTEL_SERVICE_NAME:-webcast-api}")
  ENV_VARS+=("OTEL_RESOURCE_ATTRIBUTES=${OTEL_RESOURCE_ATTRIBUTES:-deployment.environment=prod,deployment.environment.name=prod,service.version=${GIT_SHA}}")
  ENV_VARS+=("OTEL_TRACES_SAMPLER=${OTEL_TRACES_SAMPLER:-parentbased_traceidratio}")
  ENV_VARS+=("OTEL_TRACES_SAMPLER_ARG=${OTEL_TRACES_SAMPLER_ARG:-0.2}")
fi

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
  # Supabase's session pooler allows pool_size clients (15 on 24 Oct 2026, now 30),
  # and during a deploy the old and new revisions overlap: 2 x max-instances x
  # (DB_MAX_CONNS + 1 LISTEN) must fit when queries use the session pooler
  # (2 x 3 x 5 = 30: failed against 15, exactly fills 30).
  # With DATABASE_URL on the transaction pooler (:6543) only the LISTEN
  # connections count: 2 x 3 x 1 = 6. The API logs this arithmetic at boot and
  # warns when it does not fit. See deploy/SUPABASE.md "Connection budget".
  --min-instances "${MIN_INSTANCES:-0}"
  --max-instances "${MAX_INSTANCES:-3}"
  # 500 requests at once per instance, not Cloud Run's default 80. Every Edge viewer holds
  # one request open for the whole webinar (the event stream: chat, Q&A, polls), so at 80
  # the three instances above stopped at ~240 viewers and everything after — their streams
  # and every other API call — queued. An open stream is an idle goroutine, so one instance
  # holds hundreds; 3 × 500 is room for 1,500 viewers. Concurrency, not instances: more
  # instances would need more of Supabase's session-pooler clients, which these 3 fill at a
  # deploy (2 x 3 x (4 pooled + 1 LISTEN) = 30) unless DATABASE_URL is the transaction pooler.
  --concurrency "${CONCURRENCY:-500}"
  --env-vars-file "$ENV_YAML"
)

if [[ -n "${CLOUD_SQL_INSTANCE:-}" ]]; then
  DEPLOY_ARGS+=(--add-cloudsql-instances "$CLOUD_SQL_INSTANCE")
fi

run "${DEPLOY_ARGS[@]}"

echo "deployed $SERVICE — check: gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format='value(status.url)'"
