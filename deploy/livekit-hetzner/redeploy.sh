#!/usr/bin/env bash
# Safe LiveKit redeploy on an already-installed host.
# - Never rotates API keys (uses existing .env.keys)
# - Regenerates livekit.yaml from the template
# - Preserves rtc.node_ip / rtc.use_external_ip from the previous livekit.yaml
# - Pulls images and restarts compose in /opt/livekit
set -euo pipefail

TARGET="${TARGET:-/opt/livekit}"
cd "$TARGET"

if [[ ! -f .env.keys ]]; then
  echo "Missing ${TARGET}/.env.keys — run install.sh once on a fresh host first." >&2
  exit 1
fi
if [[ ! -f livekit.yaml.template ]]; then
  echo "Missing ${TARGET}/livekit.yaml.template — sync deploy files before redeploy." >&2
  exit 1
fi
if [[ ! -f docker-compose.yml ]]; then
  echo "Missing ${TARGET}/docker-compose.yml — sync deploy files before redeploy." >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "Missing ${TARGET}/.env (DOMAIN / ACME_EMAIL) — do not wipe on redeploy." >&2
  exit 1
fi

# If the caller already exported GRAFANA_ADMIN_PASSWORD (CI passes the repo
# secret of that name — see the workflow), that's the password to use and to
# persist. Capture it before `source .env.keys` below, since that would
# otherwise silently overwrite it with whatever's on disk.
REQUESTED_GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-}"

# shellcheck disable=SC1091
source .env.keys

: "${API_KEY:?API_KEY missing in .env.keys}"
: "${API_SECRET:?API_SECRET missing in .env.keys}"
: "${DOMAIN:?DOMAIN missing in .env.keys}"

if [[ -n "$REQUESTED_GRAFANA_ADMIN_PASSWORD" && "$REQUESTED_GRAFANA_ADMIN_PASSWORD" != "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  # A password the caller chose (the GitHub secret) always wins over whatever
  # is on disk, so the person who set the secret gets the password they
  # actually typed rather than one they'd need SSH to go read.
  GRAFANA_ADMIN_PASSWORD="$REQUESTED_GRAFANA_ADMIN_PASSWORD"
  keys_tmp="$(mktemp)"
  grep -v '^GRAFANA_ADMIN_PASSWORD=' .env.keys >"$keys_tmp" || :
  echo "GRAFANA_ADMIN_PASSWORD=$GRAFANA_ADMIN_PASSWORD" >>"$keys_tmp"
  umask 077
  mv "$keys_tmp" .env.keys
elif [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
  # No secret set and nothing on disk yet (host installed before Grafana was
  # added) — self-heal with a random one rather than hard-failing the whole
  # LiveKit redeploy. See README for how to switch to a chosen password.
  GRAFANA_ADMIN_PASSWORD="$(openssl rand -hex 16)"
  echo "GRAFANA_ADMIN_PASSWORD=$GRAFANA_ADMIN_PASSWORD" >>.env.keys
fi
export GRAFANA_ADMIN_PASSWORD

PRESERVE_NODE_IP=""
PRESERVE_USE_EXTERNAL_IP=""
if [[ -f livekit.yaml ]]; then
  PRESERVE_NODE_IP="$(awk '/^[[:space:]]*node_ip:/{print $2; exit}' livekit.yaml || true)"
  PRESERVE_USE_EXTERNAL_IP="$(awk '/^[[:space:]]*use_external_ip:/{print $2; exit}' livekit.yaml || true)"
fi

# Hetzner / sslip.io: pin advertised IP (STUN alone is flaky on some clouds).
if [[ -z "$PRESERVE_NODE_IP" && "$DOMAIN" =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\.sslip\.io$ ]]; then
  PRESERVE_NODE_IP="${BASH_REMATCH[1]}"
  PRESERVE_USE_EXTERNAL_IP="${PRESERVE_USE_EXTERNAL_IP:-false}"
fi

# Remote egress (EGRESS_REMOTE=true and EGRESS_VPC_CIDR=<range> in .env): the composite runs
# on worker VMs in the same VPC (deploy/egress-worker), not on this box. Redis then also
# listens on the private IP with a password, MediaMTX takes RTMP from the VPC, and the local
# egress container is not run. There is deliberately no fallback to it: a mix on the SFU box
# takes the SFU's CPU, which is what the workers exist to avoid. Unset, nothing changes.
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
EGRESS_REMOTE="$(env_value EGRESS_REMOTE)"
EGRESS_VPC_CIDR="$(env_value EGRESS_VPC_CIDR)"
# LL-HLS part length, per box (see mediamtx.yml.template). A Go duration MediaMTX accepts.
HLS_PART_DURATION="$(env_value HLS_PART_DURATION)"
HLS_PART_DURATION="${HLS_PART_DURATION:-500ms}"
[[ "$HLS_PART_DURATION" =~ ^[0-9]+ms$ ]] || { echo "HLS_PART_DURATION must look like 250ms, got $HLS_PART_DURATION" >&2; exit 1; }
REDIS_BIND="127.0.0.1 -::1"
REDIS_PASSWORD_VALUE=""
PUBLISH_IPS='["127.0.0.1", "::1"]'
RTMP_ADDRESS="127.0.0.1:1935"
if [[ "$EGRESS_REMOTE" == "true" ]]; then
  : "${EGRESS_VPC_CIDR:?EGRESS_REMOTE=true needs EGRESS_VPC_CIDR in .env (e.g. 10.160.0.0/20)}"
  PRIVATE_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
  : "${PRIVATE_IP:?could not find the private IPv4 of this box}"
  if [[ -z "${REDIS_PASSWORD:-}" ]]; then
    # Hex only, so it is safe in sed, YAML and redis.conf. Persisted with the other keys and
    # never rotated here: the workers carry the same value.
    REDIS_PASSWORD="$(openssl rand -hex 24)"
    echo "REDIS_PASSWORD=$REDIS_PASSWORD" >>.env.keys
  fi
  REDIS_BIND="127.0.0.1 -::1 ${PRIVATE_IP}"
  REDIS_PASSWORD_VALUE="$REDIS_PASSWORD"
  PUBLISH_IPS="[\"127.0.0.1\", \"::1\", \"${EGRESS_VPC_CIDR}\"]"
  RTMP_ADDRESS=":1935"
fi

umask 077
{
  echo "bind ${REDIS_BIND}"
  echo "protected-mode yes"
  echo 'save ""'
  echo "appendonly no"
  [[ -n "$REDIS_PASSWORD_VALUE" ]] && echo "requirepass ${REDIS_PASSWORD_VALUE}"
} >redis.conf
chmod 644 redis.conf
umask 022

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sed -e "s/__TURN_DOMAIN__/${DOMAIN}/g" \
    -e "s/__API_KEY__/${API_KEY}/g" \
    -e "s/__API_SECRET__/${API_SECRET}/g" \
    -e "s/__REDIS_PASSWORD__/\"${REDIS_PASSWORD_VALUE}\"/g" \
    livekit.yaml.template >"$tmp"

if [[ -n "${PRESERVE_NODE_IP}" || -n "${PRESERVE_USE_EXTERNAL_IP}" ]]; then
  use_ext="${PRESERVE_USE_EXTERNAL_IP:-false}"
  node_ip="${PRESERVE_NODE_IP}"
  awk -v use_ext="$use_ext" -v node_ip="$node_ip" '
    /^[[:space:]]*use_external_ip:/ {
      print "  use_external_ip: " use_ext
      if (node_ip != "") print "  node_ip: " node_ip
      next
    }
    /^[[:space:]]*node_ip:/ { next }
    { print }
  ' "$tmp" >"${tmp}.out"
  mv "${tmp}.out" "$tmp"
fi

livekit_config_changed=0
if [[ ! -f livekit.yaml ]] || ! cmp -s "$tmp" livekit.yaml; then
  livekit_config_changed=1
fi

umask 077
mv "$tmp" livekit.yaml
trap - EXIT

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  # 8189/udp was MediaMTX's WHEP ICE port; WHEP is gone (2026-10-20), so close it again on
  # boxes installed before. No-op where it was never opened.
  ufw delete allow 8189/udp >/dev/null 2>&1 || true
  # Redis and RTMP for the egress workers: the VPC only, never the internet.
  if [[ "$EGRESS_REMOTE" == "true" ]]; then
    ufw allow from "$EGRESS_VPC_CIDR" to any port 6379 proto tcp >/dev/null
    ufw allow from "$EGRESS_VPC_CIDR" to any port 1935 proto tcp >/dev/null
  fi
fi

# TCP for the HLS origin. The Bunny pull zone fetches each new segment and part
# over a long round trip, and with Ubuntu's defaults every request started again
# from a small window: CUBIC resets to slow start whenever a connection has sat
# idle for one RTO, which between two LL-HLS requests it always has. A 230KB
# segment then took 0.9-1.4s on a cache miss against 50-75ms on a hit, slower
# than real time, so viewers stalled and fell back to 6-8s (2026-10-19). Keep the
# window across idle gaps and use BBR, which does not read one lost packet on a
# long path as congestion. Only TCP: LiveKit's media is UDP and is not affected.
if modprobe tcp_bbr 2>/dev/null || grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null; then
  cat >/etc/sysctl.d/90-webinarliv-origin.conf <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_slow_start_after_idle = 0
SYSCTL
else
  echo "tcp_bbr unavailable; keeping the default congestion control" >&2
  echo "net.ipv4.tcp_slow_start_after_idle = 0" >/etc/sysctl.d/90-webinarliv-origin.conf
fi
sysctl -q -p /etc/sysctl.d/90-webinarliv-origin.conf || echo "sysctl: could not apply origin TCP settings" >&2

if [[ -f mediamtx.yml.template ]]; then
  sed -e "s|__PUBLISH_IPS__|${PUBLISH_IPS}|g" \
      -e "s/__RTMP_ADDRESS__/${RTMP_ADDRESS}/g" \
      -e "s/__HLS_PART_DURATION__/${HLS_PART_DURATION}/g" \
      mediamtx.yml.template > mediamtx.yml
fi

# Generate egress.yaml if template is present
if [[ -f egress.yaml.template ]]; then
  sed -e "s/__API_KEY__/${API_KEY}/g" \
      -e "s/__API_SECRET__/${API_SECRET}/g" \
      -e "s/__DOMAIN__/${DOMAIN}/g" \
      -e "s/__REDIS_PASSWORD__/\"${REDIS_PASSWORD_VALUE}\"/g" \
      egress.yaml.template > egress.yaml
  chmod 644 egress.yaml
fi

COMPOSE_ARGS=("-f" "docker-compose.yml")
LOCAL_EGRESS=0
if [[ -f docker-compose.egress.yml && -f egress.yaml ]]; then
  COMPOSE_ARGS+=("-f" "docker-compose.egress.yml")
  if [[ "$EGRESS_REMOTE" != "true" ]]; then
    LOCAL_EGRESS=1
    COMPOSE_ARGS=("--profile" "local-egress" "${COMPOSE_ARGS[@]}")
  fi
fi
# Switching to remote egress leaves the old local container behind; remove it.
if [[ "$EGRESS_REMOTE" == "true" ]]; then
  docker ps -aq --filter label=com.docker.compose.service=egress | xargs -r docker rm -f >/dev/null
fi

# Server-side live captions (deploy/captions, synced to ./captions). Opt-in with
# CAPTIONS_ENABLED=true and CAPTIONS_SECRET (the API's, 32+ chars) in .env; every other
# CAPTIONS_* line in .env is passed to the agent as is. A missing secret skips captions
# with a warning rather than failing the LiveKit redeploy. Capped and deprioritised so it
# cannot slow video: see docker-compose.captions.yml.
CAPTIONS=0
if [[ "$(env_value CAPTIONS_ENABLED)" == "true" ]]; then
  CAPTIONS_SECRET_VALUE="$(env_value CAPTIONS_SECRET)"
  if (( ${#CAPTIONS_SECRET_VALUE} < 32 )); then
    echo "CAPTIONS_ENABLED=true but CAPTIONS_SECRET is missing or under 32 characters; captions not started" >&2
  elif [[ ! -f docker-compose.captions.yml || ! -f captions/Dockerfile ]]; then
    echo "CAPTIONS_ENABLED=true but docker-compose.captions.yml or captions/ is missing; sync deploy files" >&2
  else
    umask 077
    {
      echo "LIVEKIT_URL=ws://127.0.0.1:7880"
      echo "LIVEKIT_API_KEY=${API_KEY}"
      echo "LIVEKIT_API_SECRET=${API_SECRET}"
      echo "CAPTIONS_API_URL=$(env_value CAPTIONS_API_URL | sed 's|/*$||' | grep . || echo https://webinarliv.com)"
      grep -E '^CAPTIONS_' .env | grep -vE '^CAPTIONS_(ENABLED|IMAGE|MEMORY|API_URL)=' | tr -d '"' || true
    } >captions.env
    umask 022
    COMPOSE_ARGS+=("-f" "docker-compose.captions.yml")
    CAPTIONS=1
  fi
fi
if [[ "$CAPTIONS" != 1 ]]; then
  docker ps -aq --filter label=com.docker.compose.service=captions | xargs -r docker rm -f >/dev/null
  rm -f captions.env
fi

if [[ "$CAPTIONS" == 1 && -z "$(env_value CAPTIONS_IMAGE)" ]]; then
  # Built here from ./captions; the first build takes a few minutes, later ones are cached.
  docker compose "${COMPOSE_ARGS[@]}" build captions
  docker compose "${COMPOSE_ARGS[@]}" pull --ignore-buildable
else
  docker compose "${COMPOSE_ARGS[@]}" pull
fi
docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans
# redis.conf is bind-mounted and read at start only, like the Caddyfile below. Before
# LiveKit, so LiveKit never comes up against a Redis with the old password.
if [[ -f docker-compose.egress.yml ]]; then
  docker compose "${COMPOSE_ARGS[@]}" restart redis
fi
# Restart livekit to ensure it connects to Redis if Redis was newly started
docker compose "${COMPOSE_ARGS[@]}" restart livekit
if [[ "$LOCAL_EGRESS" == 1 ]]; then
  docker compose "${COMPOSE_ARGS[@]}" restart egress
fi

# Caddyfile is bind-mounted, so `up -d` alone does not make Caddy pick up
# edits to it — the config-hash docker compose diffs against is the compose
# service definition, not the mounted file's content, and Caddy itself only
# reads Caddyfile at process start (no live-reload without an explicit
# `caddy reload`). Restart it unconditionally on every redeploy instead of
# depending on that heuristic to happen to also recreate the container.
docker compose "${COMPOSE_ARGS[@]}" restart caddy
if [[ -f docker-compose.egress.yml ]]; then
  docker compose "${COMPOSE_ARGS[@]}" restart mediamtx
fi

# The API's background pass, once a minute (TICK_URL and TICK_SECRET in .env).
#
# Cloud Run scales the API to zero and gives it CPU only during requests, so its own ticker
# does not run while nobody is using the app: a simulive would not start, reminders and drips
# would wait for the next visitor. This box is always on, so it is the visitor. The secret
# stays in .env (read by the script at run time), never in the world-readable cron file. A
# second box doing the same is harmless: the API takes a lease, and the loser answers "busy".
# Either value unset: no cron, and an old one is removed.
TICK_URL="$(env_value TICK_URL)"
if [[ -n "$TICK_URL" && -n "$(env_value TICK_SECRET)" ]]; then
  cat >"${TARGET}/tick.sh" <<'TICK'
#!/usr/bin/env bash
# One background pass of the API (see redeploy.sh). Quiet unless it fails.
set -euo pipefail
cd "$(dirname "$0")"
v() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"'; }
curl -fsS -m 55 -X POST -H "X-Tick-Secret: $(v TICK_SECRET)" "$(v TICK_URL)" >/dev/null
TICK
  chmod 700 "${TARGET}/tick.sh"
  echo "* * * * * root ${TARGET}/tick.sh 2>&1 | logger -t webinarliv-tick" >/etc/cron.d/webinarliv-tick
  chmod 644 /etc/cron.d/webinarliv-tick
  echo "API tick: every minute to ${TICK_URL}"
else
  rm -f /etc/cron.d/webinarliv-tick "${TARGET}/tick.sh"
fi

echo "LiveKit redeployed at wss://${DOMAIN} (keys unchanged in ${TARGET}/.env.keys)"
if [[ "$CAPTIONS" == 1 ]]; then
  echo "Server captions: on (docker compose logs captions; first start downloads the models)"
fi
echo "Grafana: https://${DOMAIN}/grafana/ (user: admin, password in ${TARGET}/.env.keys)"
