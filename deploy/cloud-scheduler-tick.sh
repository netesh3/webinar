#!/usr/bin/env bash
# Create or update the Cloud Scheduler job that runs the API's background pass every
# minute: POST {API}/api/internal/tick with X-Tick-Secret.
#
# Why: Cloud Run scales webcast-api to zero and throttles CPU between requests, so the
# in-process 30 s ticker does not run while nobody is using the app. Reminders, drips,
# bots, broadcasts and meeting limits would wait for the next visitor. This job is the
# visitor. Every job is due-time driven, so a pass after a gap sends what came due in it.
#
# Needs TICK_SECRET (the same value deployed to the service; see cloudrun.env.example)
# from deploy/cloudrun.env or the environment. Safe to run again: it updates the job.
# The secret is sent as a header and never printed.
#
# Usage:
#   ./deploy/cloud-scheduler-tick.sh            # create or update
#   ./deploy/cloud-scheduler-tick.sh --dry-run  # print the planned commands (secret masked)
#   ./deploy/cloud-scheduler-tick.sh --pause | --resume
#
# On a dedicated server, instead of this: one crontab line,
#   * * * * * curl -fsS -X POST -H "X-Tick-Secret: $TICK_SECRET" https://api.example/api/internal/tick >/dev/null

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/deploy/cloudrun.env"

PROJECT="${GCP_PROJECT:-selfreminder-rnix}"
REGION="${GCP_REGION:-asia-south1}"
SERVICE="${SERVICE_NAME:-webcast-api}"
JOB="${TICK_JOB_NAME:-${SERVICE}-tick}"
SCHEDULE="${TICK_SCHEDULE:-* * * * *}"

MODE=apply
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --pause) MODE=pause ;;
    --resume) MODE=resume ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    local out=()
    for a in "$@"; do out+=("${a//${TICK_SECRET:-__none__}/****}"); done
    printf '+'; printf ' %q' "${out[@]}"; echo
  else
    "$@"
  fi
}

if [[ "$MODE" != apply ]]; then
  run gcloud scheduler jobs "$MODE" "$JOB" --location "$REGION" --project "$PROJECT"
  exit 0
fi

if [[ -z "${TICK_SECRET:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi
if [[ -z "${TICK_SECRET:-}" ]]; then
  echo "TICK_SECRET is not set (deploy/cloudrun.env or the environment)." >&2
  echo "Generate one with: openssl rand -hex 32 — and deploy it to the service first." >&2
  exit 1
fi
if [[ ${#TICK_SECRET} -lt 32 ]]; then
  echo "TICK_SECRET must be at least 32 characters; the API refuses to boot otherwise." >&2
  exit 1
fi

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
  --format='value(status.url)')"
if [[ -z "$URL" ]]; then
  echo "Could not find Cloud Run service $SERVICE in $REGION." >&2
  exit 1
fi
TARGET="${URL}/api/internal/tick"

run gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT"

# One attempt per minute is the schedule itself, so retries are off: a failed tick is
# followed by the next one in sixty seconds. The deadline covers a cold start plus one
# pass (the API bounds a pass at 90 s).
ARGS=(
  --location "$REGION" --project "$PROJECT"
  --schedule "$SCHEDULE" --time-zone "Etc/UTC"
  --uri "$TARGET" --http-method POST
  --attempt-deadline 180s
  --max-retry-attempts 0
)

if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  run gcloud scheduler jobs update http "$JOB" "${ARGS[@]}" \
    --update-headers "X-Tick-Secret=${TICK_SECRET}"
else
  run gcloud scheduler jobs create http "$JOB" "${ARGS[@]}" \
    --headers "X-Tick-Secret=${TICK_SECRET}"
fi

echo "scheduler job $JOB -> $TARGET ($SCHEDULE UTC)"
echo "check: gcloud scheduler jobs run $JOB --location $REGION --project $PROJECT && gcloud run services logs read $SERVICE --region $REGION --project $PROJECT --limit 20"
