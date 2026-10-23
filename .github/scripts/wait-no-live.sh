#!/usr/bin/env bash
# Deploy guard: wait until no session a deploy would interrupt is running, then return.
#
# The FIRST step of every deploy job (see docs/DEPLOYMENT-TOPOLOGY.md, "Deploy guard"). Asks
# the production API's GET /api/internal/live-status (X-Tick-Secret: TICK_SECRET) and, while
# anything in scope is live, prints the blocking slugs and re-checks every POLL_SEC, up to
# WAIT_TIMEOUT_MIN. Exit 0 = safe to deploy; non-zero = do not deploy.
#
# Environment:
#   GUARD_SCOPE        "any" (API / Web deploys: any session anywhere) or a LiveKit project id
#                      (a video-server box deploy: only sessions on that box, e.g. do-blr,
#                      including ones still "finalizing" their after-session transcript there)
#   GUARD_MODE         "api"  — the API is what is being deployed: when the API itself is down
#                               (/readyz fails) or does not have the endpoint yet (404, i.e. an
#                               older build), proceed with a warning: the deploy is the fix.
#                      "strict" — anything else (Web, LiveKit boxes): an unanswerable question
#                               is retried for UNREACHABLE_GRACE_MIN (an API deploy may be
#                               landing), then the job FAILS. Never deploy blind onto a box.
#   TICK_SECRET        required (the same repo secret the API deploy ships)
#   API_BASE           default https://webcast-api-65278594492.asia-south1.run.app
#   FORCE              "true" skips the guard entirely (workflow_dispatch input), with a warning
#   WAIT_TIMEOUT_MIN   default 180 (well inside GitHub's 6 h job limit)
#   POLL_SEC           default 60
#   UNREACHABLE_GRACE_MIN default 10
set -uo pipefail

SCOPE="${GUARD_SCOPE:-any}"
MODE="${GUARD_MODE:-strict}"
API_BASE="${API_BASE:-https://webcast-api-65278594492.asia-south1.run.app}"
API_BASE="${API_BASE%/}"
WAIT_TIMEOUT_MIN="${WAIT_TIMEOUT_MIN:-180}"
POLL_SEC="${POLL_SEC:-60}"
UNREACHABLE_GRACE_MIN="${UNREACHABLE_GRACE_MIN:-10}"

if [ "${FORCE:-false}" = "true" ]; then
  echo "::warning::Deploy guard SKIPPED (force=true): deploying without checking for live sessions (scope ${SCOPE})."
  exit 0
fi

case "$MODE" in api | strict) ;; *)
  echo "::error::GUARD_MODE must be 'api' or 'strict', got '${MODE}'."
  exit 2
  ;;
esac

if [ -z "${TICK_SECRET:-}" ]; then
  if [ "$MODE" = "api" ]; then
    echo "::warning::TICK_SECRET is not set, so the live-status endpoint is not mounted and cannot be asked. Proceeding (API deploy)."
    exit 0
  fi
  echo "::error::Deploy guard: repository secret TICK_SECRET is not set, so live sessions cannot be checked. Not deploying. Set it, or re-run with force=true."
  exit 1
fi

api_down() {
  ! curl -fsS -o /dev/null --max-time 20 "${API_BASE}/readyz" 2>/dev/null
}

start=$(date +%s)
deadline=$((start + WAIT_TIMEOUT_MIN * 60))
unreachable_since=""
body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

while :; do
  now=$(date +%s)
  code="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 20 \
    -H "X-Tick-Secret: ${TICK_SECRET}" "${API_BASE}/api/internal/live-status" 2>/dev/null)" || code="000"

  if [ "$code" = "200" ] && jq -e '.live | type == "array"' "$body_file" >/dev/null 2>&1; then
    unreachable_since=""
    if [ "$SCOPE" = "any" ]; then
      filter='.live'
    else
      # A box deploy also waits for post-session work on that box: sessions that ended in the
      # last 35 min whose after-session transcript the box's caption agent is still making
      # (state "finalizing"). Replacing the captions container then would cut it off, and the
      # AI recap waits for it. An older API has no .finalizing: treated as none.
      # shellcheck disable=SC2016 # $p is a jq variable, not a shell one
      filter='[(.live + (.finalizing // []))[] | select(.project == $p)]'
    fi
    blocking="$(jq -r --arg p "$SCOPE" "${filter} | .[] | \"  \\(.slug)  \\(.kind)/\\(.state)  on \\(.project)\"" "$body_file")"
    total="$(jq -r '.count' "$body_file")"
    if [ -z "$blocking" ]; then
      echo "Deploy guard: nothing live in scope '${SCOPE}' (${total} live in total). Deploying."
      exit 0
    fi
    n="$(printf '%s\n' "$blocking" | wc -l | tr -d ' ')"
    waited=$(((now - start) / 60))
    echo "Deploy guard: ${n} session(s) live or finalizing in scope '${SCOPE}', waiting (${waited}/${WAIT_TIMEOUT_MIN} min):"
    printf '%s\n' "$blocking"
  else
    # The question could not be answered.
    if [ "$MODE" = "api" ]; then
      if [ "$code" = "404" ]; then
        echo "::warning::Deploy guard: the running API has no /api/internal/live-status (older build). Proceeding with the API deploy."
        exit 0
      fi
      if api_down; then
        echo "::warning::Deploy guard: the API is down (/readyz fails), so nothing can be checked and the deploy is the fix. Proceeding."
        exit 0
      fi
    fi
    [ -n "$unreachable_since" ] || unreachable_since=$now
    down_min=$(((now - unreachable_since) / 60))
    echo "::warning::Deploy guard: live-status answered HTTP ${code} (unanswered for ${down_min}/${UNREACHABLE_GRACE_MIN} min)."
    if [ $((now - unreachable_since)) -ge $((UNREACHABLE_GRACE_MIN * 60)) ]; then
      case "$code" in
        401) why="TICK_SECRET in GitHub does not match the API's" ;;
        404) why="the API does not serve /api/internal/live-status (TICK_SECRET unset on the API, or an older build)" ;;
        000) why="the API is unreachable" ;;
        *) why="the API answered HTTP ${code}" ;;
      esac
      echo "::error::Deploy guard: cannot tell whether a session is live (${why}). Not deploying, so nothing live is cut off. Fix that, or re-run with force=true."
      exit 1
    fi
  fi

  if [ $((now + POLL_SEC)) -gt "$deadline" ]; then
    echo "::error::Deploy guard: sessions still live after ${WAIT_TIMEOUT_MIN} min (listed above). Not deploying. Re-run when they end, or with force=true."
    exit 1
  fi
  sleep "$POLL_SEC"
done
