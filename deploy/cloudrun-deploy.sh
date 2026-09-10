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

PROJECT="${GCP_PROJECT:-ai-project-490516}"
REGION="${GCP_REGION:-us-central1}"
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

run gcloud builds submit "$ROOT/api" \
  --tag "$IMAGE" \
  --project "$PROJECT"

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
  "RECORDINGS_ENABLED=${RECORDINGS_ENABLED:-false}"
  "SEED_DEV=${SEED_DEV:-false}"
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

# Join env vars with commas for gcloud (values must not contain commas).
JOINED=$(IFS=,; echo "${ENV_VARS[*]}")

DEPLOY_ARGS=(
  gcloud run deploy "$SERVICE"
  --image "$IMAGE"
  --region "$REGION"
  --project "$PROJECT"
  --platform managed
  --allow-unauthenticated
  --port 8080
  --memory 512Mi
  --cpu 1
  --min-instances 0
  --max-instances 3
  --set-env-vars "$JOINED"
)

if [[ -n "${CLOUD_SQL_INSTANCE:-}" ]]; then
  DEPLOY_ARGS+=(--add-cloudsql-instances "$CLOUD_SQL_INSTANCE")
fi

run "${DEPLOY_ARGS[@]}"

echo "deployed $SERVICE — check: gcloud run services describe $SERVICE --region $REGION --project $PROJECT --format='value(status.url)'"
