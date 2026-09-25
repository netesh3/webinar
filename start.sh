#!/usr/bin/env bash
#
# Starts the whole Webcast stack: Postgres, the LiveKit SFU, the Go API and the
# Next.js frontend.
#
# Each service is health-checked before the next one starts, so a failure points
# at the thing that actually broke instead of surfacing three steps later as a
# blank page. Already-healthy services are adopted rather than duplicated, so
# running this twice is safe.
#
#   ./start.sh              start everything
#   ./start.sh --rebuild    force a rebuild of the API and LiveKit binaries
#   ./start.sh --logs       start, then tail all logs
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"

# Homebrew first: launchd and GUI terminals often have a PATH without it.
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:$PATH"

RUN_DIR="$ROOT/.run"
LOG_DIR="$RUN_DIR/logs"
BIN_DIR="$RUN_DIR/bin"
mkdir -p "$RUN_DIR" "$LOG_DIR" "$BIN_DIR"

LIVEKIT_BIN="$ROOT/infra/bin/livekit-server"
LIVEKIT_VER="v1.13.7"

PG_PORT=5432
LK_PORT=7880
API_PORT=8080
WEB_PORT=3000

DB_URL="postgres://webcast:webcast@localhost:${PG_PORT}/webcast?sslmode=disable"

REBUILD=0
TAIL_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --logs)    TAIL_LOGS=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------------ output

if [[ -t 1 ]]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

step()  { printf '%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()   { printf '  %s✗%s %s\n' "$R" "$N" "$1" >&2; exit 1; }
note()  { printf '    %s%s%s\n' "$D" "$1" "$N"; }

# ------------------------------------------------------------------ helpers

# pids_on <port> — who is listening, if anyone.
pids_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

http_ok() { curl -sf -o /dev/null --max-time 3 "$1" 2>/dev/null; }

# wait_for <label> <url> <seconds>
wait_for() {
  local label="$1" url="$2" limit="${3:-60}" i=0
  while (( i < limit )); do
    if http_ok "$url"; then return 0; fi
    sleep 1; i=$((i+1))
    if (( i % 10 == 0 )); then note "still waiting for $label (${i}s)…"; fi
  done
  return 1
}

# start_bg <name> <command...> — launch detached, record the pid.
start_bg() {
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"
  : >"$log"
  # nohup + disown so the service outlives this script and the terminal that ran
  # it. Without nohup the shell's exit sends SIGHUP and everything dies moments
  # after "All services up" prints.
  nohup "$@" >>"$log" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$RUN_DIR/$name.pid"
  sleep 0.4
}

require() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; }

printf '\n%s Webcast — starting up%s\n\n' "$B" "$N"

# ------------------------------------------------------------------ preflight

step "Preflight"
require go   "Install with: brew install go"
require node "Install with: brew install node"
require psql "Install with: brew install postgresql@18"
ok "go $(go version | awk '{print $3}'), node $(node -v), psql present"

[[ -d "$ROOT/web/node_modules" ]] || die "web/node_modules missing. Run: cd web && npm install"
ok "frontend dependencies installed"

# ------------------------------------------------------------------ postgres

step "Postgres"
if pg_isready -h localhost -p "$PG_PORT" -q 2>/dev/null; then
  ok "already running on :$PG_PORT"
else
  brew services start postgresql@18 >/dev/null 2>&1 || die "could not start postgresql@18"
  i=0
  until pg_isready -h localhost -p "$PG_PORT" -q 2>/dev/null; do
    sleep 1; i=$((i+1))
    (( i > 30 )) && die "Postgres did not become ready in 30s"
  done
  ok "started on :$PG_PORT"
fi

# Role and databases. Idempotent, so this is safe on every boot.
psql -h localhost -d postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='webcast'" 2>/dev/null | grep -q 1 \
  || psql -h localhost -d postgres -q -c \
       "CREATE ROLE webcast LOGIN PASSWORD 'webcast' CREATEDB;" >/dev/null
for db in webcast webcast_test; do
  psql -h localhost -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null | grep -q 1 \
    || psql -h localhost -d postgres -q -c "CREATE DATABASE $db OWNER webcast;" >/dev/null
done
ok "databases webcast + webcast_test ready"

# ------------------------------------------------------------------ livekit

step "LiveKit SFU"
if (( REBUILD )) || [[ ! -x "$LIVEKIT_BIN" ]]; then
  # There is no darwin release tarball, so it is compiled from source. Slow the
  # first time (~2 min), cached afterwards.
  warn "building LiveKit $LIVEKIT_VER from source (first run takes a couple of minutes)"
  mkdir -p "$(dirname "$LIVEKIT_BIN")"
  rm -rf /tmp/livekit-src
  git clone --quiet --depth 1 --branch "$LIVEKIT_VER" \
    https://github.com/livekit/livekit.git /tmp/livekit-src \
    || die "could not clone LiveKit"
  ( cd /tmp/livekit-src && go build -o "$LIVEKIT_BIN" ./cmd/server ) \
    || die "LiveKit build failed"
  ok "built $("$LIVEKIT_BIN" --version)"
fi

if http_ok "http://localhost:$LK_PORT/"; then
  ok "already running on :$LK_PORT"
else
  [[ -z "$(pids_on "$LK_PORT")" ]] \
    || die ":$LK_PORT is occupied by something that isn't answering. Run ./stop.sh"
  start_bg livekit "$LIVEKIT_BIN" \
    --config "$ROOT/infra/livekit.local.yaml" --node-ip 127.0.0.1
  wait_for "LiveKit" "http://localhost:$LK_PORT/" 30 \
    || { tail -20 "$LOG_DIR/livekit.log"; die "LiveKit did not come up — see $LOG_DIR/livekit.log"; }
  ok "started on :$LK_PORT  $D(UDP 50000-50060, TCP 7881)$N"
fi

# Google OAuth for Connect YouTube / Drive, and the Meta app behind Connect
# WhatsApp. Sourced from .env without clobbering the local DATABASE_URL this
# script just set — which is why this is an allowlist and not `source`.
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      GOOGLE_CLIENT_ID=*|GOOGLE_CLIENT_SECRET=*|GOOGLE_API_KEY=*)
        export "$line"
        ;;
      META_APP_ID=*|META_APP_SECRET=*|META_WHATSAPP_CONFIG_ID=*|META_WEBHOOK_VERIFY_TOKEN=*|WHATSAPP_GRAPH_URL=*)
        export "$line"
        ;;
    esac
  done < "$ROOT/.env"
fi

step "Go API"
if http_ok "http://localhost:$API_PORT/readyz"; then
  ok "already running on :$API_PORT"
else
  [[ -z "$(pids_on "$API_PORT")" ]] \
    || die ":$API_PORT is occupied but not ready. Run ./stop.sh"

  # Compiled rather than `go run`: an explicit binary means the pid we record is
  # the process that actually serves traffic, so stop.sh can kill it reliably.
  #
  # CGO off, matching api/Dockerfile and `make deploy-build`. Nothing here needs
  # it — pgx is pure Go — and leaving it on makes the link step shell out to the
  # system linker, which fails outright when the Command Line Tools binaries are
  # older than the SDK they ship alongside ("unknown architecture arm64e.x1" from
  # tapi). Local builds should not depend on the Xcode install being coherent.
  ( cd "$ROOT/api" && CGO_ENABLED=0 go build -o "$BIN_DIR/webcast-api" ./cmd/server ) \
    || die "API build failed"

  APP_ENV=development \
  DATABASE_URL="$DB_URL" \
  SEED_DEV="${SEED_DEV:-true}" \
  LIVEKIT_URL="ws://localhost:$LK_PORT" \
  ADDR=":$API_PORT" \
  GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}" \
  GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}" \
  GOOGLE_API_KEY="${GOOGLE_API_KEY:-}" \
  META_APP_ID="${META_APP_ID:-}" \
  META_APP_SECRET="${META_APP_SECRET:-}" \
  META_WHATSAPP_CONFIG_ID="${META_WHATSAPP_CONFIG_ID:-}" \
  META_WEBHOOK_VERIFY_TOKEN="${META_WEBHOOK_VERIFY_TOKEN:-}" \
  WHATSAPP_GRAPH_URL="${WHATSAPP_GRAPH_URL:-}" \
    start_bg api "$BIN_DIR/webcast-api"

  wait_for "the API" "http://localhost:$API_PORT/readyz" 45 \
    || { tail -25 "$LOG_DIR/api.log"; die "API did not become ready — see $LOG_DIR/api.log"; }
  ok "started on :$API_PORT  $D(migrated + seeded)$N"
fi

# ------------------------------------------------------------------ web

step "Next.js frontend"
if http_ok "http://localhost:$WEB_PORT/"; then
  ok "already running on :$WEB_PORT"
else
  [[ -z "$(pids_on "$WEB_PORT")" ]] \
    || die ":$WEB_PORT is occupied but not serving. Run ./stop.sh"
  ( cd "$ROOT/web" && start_bg web npm run dev -- --port "$WEB_PORT" )
  wait_for "the frontend" "http://localhost:$WEB_PORT/" 90 \
    || { tail -25 "$LOG_DIR/web.log"; die "frontend did not come up — see $LOG_DIR/web.log"; }
  ok "started on :$WEB_PORT"
fi

# ------------------------------------------------------------------ summary

printf '\n%s All services up%s\n\n' "$G$B" "$N"
printf '  %sAttendees%s   http://localhost:%s\n'            "$B" "$N" "$WEB_PORT"
printf '  %sHost portal%s http://localhost:%s/host/login\n' "$B" "$N" "$WEB_PORT"
printf '               %sneeraj@acme.dev / webcast-dev%s\n' "$D" "$N"
printf '\n'
printf '  API          http://localhost:%s/readyz\n' "$API_PORT"
printf '  SFU          ws://localhost:%s\n'          "$LK_PORT"
printf '\n'
printf '  %sLogs%s        %s/{livekit,api,web}.log\n' "$D" "$N" "${LOG_DIR#$ROOT/}"
printf '  %sStop%s        ./stop.sh\n'                "$D" "$N"
printf '  %sRoom state%s  make room SLUG=scaling-webrtc-10k\n' "$D" "$N"
printf '\n'

if (( TAIL_LOGS )); then
  step "Tailing logs (Ctrl-C to stop tailing; services keep running)"
  tail -f "$LOG_DIR"/*.log
fi
