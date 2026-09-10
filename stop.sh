#!/usr/bin/env bash
#
# Stops the Webcast stack.
#
# Postgres is left running by default: it is a shared Homebrew service you may
# well be using for something else. Pass --db to stop it too.
#
#   ./stop.sh          stop web, API and the SFU
#   ./stop.sh --db     also stop Postgres
#   ./stop.sh --all    same as --db, plus the headless Chrome instances the
#                      E2E test leaves behind
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$PWD"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@18/bin:$PATH"

RUN_DIR="$ROOT/.run"

STOP_DB=0
STOP_CHROME=0
for arg in "$@"; do
  case "$arg" in
    --db)      STOP_DB=1 ;;
    --all)     STOP_DB=1; STOP_CHROME=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; D=""; N=""
fi
step() { printf '%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
note() { printf '    %s%s%s\n' "$D" "$1" "$N"; }

pids_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

# Ask nicely, then insist. npm and next spawn children, so the whole tree goes.
term_tree() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || true
  pkill -TERM -P "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.3
  done
  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -KILL "$pid" 2>/dev/null || true
}

# stop_service <name> <port>
#
# Tries the recorded pid first, then sweeps the port. The sweep matters because
# services started by hand (make api, npm run dev) have no pid file here.
stop_service() {
  # Declared separately: `local a=1 b=$a` fails under `set -u`, because bash
  # expands every argument to `local` before any of them are assigned.
  local name="$1"
  local port="$2"
  local pidfile="$RUN_DIR/$name.pid"
  local stopped=0

  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      term_tree "$pid"
      stopped=1
    fi
    rm -f "$pidfile"
  fi

  local remaining
  remaining="$(pids_on "$port")"
  if [[ -n "$remaining" ]]; then
    note "sweeping :$port (started outside ./start.sh)"
    while read -r pid; do
      [[ -n "$pid" ]] && term_tree "$pid"
    done <<<"$remaining"
    stopped=1
  fi

  # Confirm the port is genuinely free.
  sleep 0.5
  if [[ -n "$(pids_on "$port")" ]]; then
    warn "$name: :$port is still occupied"
    return 1
  fi

  if (( stopped )); then ok "$name stopped (:$port free)"; else ok "$name was not running"; fi
}

printf '\n%s Webcast — shutting down%s\n\n' "$B" "$N"

# Reverse of startup order: the frontend first, the SFU last, so nothing is
# briefly serving a page whose backend has already gone.
step "Stopping services"
stop_service web 3000     || true
stop_service api 8080     || true
stop_service livekit 7880 || true

if (( STOP_CHROME )); then
  step "Headless Chrome from the E2E test"
  if pgrep -f 'remote-debugging-port=92' >/dev/null 2>&1; then
    pkill -f 'remote-debugging-port=92' 2>/dev/null || true
    sleep 1
    ok "E2E browsers closed"
  else
    ok "none running"
  fi
  rm -rf /tmp/prof-host /tmp/prof-a1 /tmp/prof-a2
fi

if (( STOP_DB )); then
  step "Postgres"
  if pg_isready -h localhost -q 2>/dev/null; then
    brew services stop postgresql@18 >/dev/null 2>&1 || warn "could not stop postgresql@18"
    sleep 1
    if pg_isready -h localhost -q 2>/dev/null; then
      warn "Postgres is still accepting connections"
    else
      ok "Postgres stopped"
    fi
  else
    ok "Postgres was not running"
  fi
else
  step "Postgres"
  note "left running — pass --db to stop it too"
fi

printf '\n%s Done%s\n\n' "$G$B" "$N"

# Final honest report rather than assuming the kills worked.
printf '  %sPort status%s\n' "$D" "$N"
for entry in "3000:web" "8080:api" "7880:livekit" "5432:postgres"; do
  port="${entry%%:*}"; label="${entry##*:}"
  if [[ -n "$(pids_on "$port")" ]]; then
    printf '    :%-5s %-9s %sstill listening%s\n' "$port" "$label" "$Y" "$N"
  else
    printf '    :%-5s %-9s free\n' "$port" "$label"
  fi
done
printf '\n  %sStart again with ./start.sh%s\n\n' "$D" "$N"
