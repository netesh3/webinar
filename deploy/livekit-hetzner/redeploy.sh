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

# TURN over TLS on :443 (TURN_TLS_443=true in .env), for participants whose network lets out
# only TCP 443. Caddy keeps :443 and splits it by SNI (Caddyfile.turn443, a Caddy build with
# the layer4 app): ClientHellos for TURN_TLS_DOMAIN (default turn.<DOMAIN>; sslip.io resolves
# it to the same IP, a real domain needs the DNS record) are TLS-terminated by Caddy and passed
# as plain TCP to LiveKit's TURN on 127.0.0.1:5349 (external_tls). LiveKit then offers
# turns:<TURN_TLS_DOMAIN>:443?transport=tcp to every client, and turn.domain is that name for
# TURN/UDP too. The relay ports are kept inside the WebRTC UDP range ufw already opens, since
# relay and SFU reach each other on the node IP. Unset: livekit.yaml is as before.
TURN_TLS_443="$(env_value TURN_TLS_443)"
TURN_TLS_DOMAIN="$(env_value TURN_TLS_DOMAIN)"
TURN_TLS_DOMAIN="${TURN_TLS_DOMAIN:-turn.${DOMAIN}}"
TURN_DOMAIN="$DOMAIN"
TURN_TLS_BLOCK=""
if [[ "$TURN_TLS_443" == "true" ]]; then
  [[ "$TURN_TLS_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "TURN_TLS_DOMAIN is not a hostname: $TURN_TLS_DOMAIN" >&2; exit 1; }
  if [[ ! -f docker-compose.turn443.yml || ! -f Caddyfile.turn443 || ! -f caddy-l4/Dockerfile ]]; then
    echo "TURN_TLS_443=true but docker-compose.turn443.yml, Caddyfile.turn443 or caddy-l4/ is missing; sync deploy files" >&2
    exit 1
  fi
  TURN_DOMAIN="$TURN_TLS_DOMAIN"
  TURN_TLS_BLOCK=$'  tls_port: 5349\n  external_tls: true\n  relay_range_start: 50000\n  relay_range_end: 60000'
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sed -e "s/__TURN_DOMAIN__/${TURN_DOMAIN}/g" \
    -e "s/__API_KEY__/${API_KEY}/g" \
    -e "s/__API_SECRET__/${API_SECRET}/g" \
    -e "s/__REDIS_PASSWORD__/\"${REDIS_PASSWORD_VALUE}\"/g" \
    livekit.yaml.template |
  awk -v block="$TURN_TLS_BLOCK" '
    /^[[:space:]]*#__TURN_TLS__[[:space:]]*$/ { if (block != "") print block; next }
    { print }
  ' >"$tmp"

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

# The on-demand DigitalOcean box (deploy/digitalocean/README.md): SFU_DATA_DIR=/mnt/sfu-data in
# .env puts Caddy's certificates and the caption models and spool on the sfu-data volume
# (docker-compose.data.yml), so a new droplet starts with them. A named volume made before the
# switch (on the droplet's own disk) is replaced by the bind to the volume, once. Unset: as before.
SFU_DATA_DIR="$(env_value SFU_DATA_DIR)"
if [[ -n "$SFU_DATA_DIR" ]]; then
  [[ "$SFU_DATA_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "SFU_DATA_DIR must be an absolute path, got $SFU_DATA_DIR" >&2; exit 1; }
  if ! mountpoint -q "$SFU_DATA_DIR"; then
    echo "SFU_DATA_DIR=$SFU_DATA_DIR is not a mounted volume; refusing to put the box's state on the droplet's disk" >&2
    exit 1
  fi
  [[ -f docker-compose.data.yml ]] || { echo "SFU_DATA_DIR set but docker-compose.data.yml is missing; sync deploy files" >&2; exit 1; }
  export SFU_DATA_DIR
  project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
  for v in caddy_data caddy_config captions_models captions_spool; do
    mkdir -p "${SFU_DATA_DIR}/docker/${v}"
    if docker volume inspect "${project}_${v}" >/dev/null 2>&1; then
      dev="$(docker volume inspect -f '{{ index .Options "device" }}' "${project}_${v}" 2>/dev/null || true)"
      if [[ "$dev" != "${SFU_DATA_DIR}/docker/${v}" ]]; then
        echo "Moving ${project}_${v} onto ${SFU_DATA_DIR}/docker/${v}"
        docker ps -aq --filter "volume=${project}_${v}" | xargs -r docker rm -f >/dev/null
        docker volume rm "${project}_${v}" >/dev/null
      fi
    fi
  done
  # The caption agent runs as uid 10001 (deploy/captions/Dockerfile).
  chown 10001:10001 "${SFU_DATA_DIR}/docker/captions_models" "${SFU_DATA_DIR}/docker/captions_spool"
  # Added last (below), after docker-compose.captions.yml, so its definitions win.
  DATA_COMPOSE=1
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

# Cloud recording from the edge mix (./mixrec, docker-compose.mixrec.yml). Opt-in with
# MIXREC_SECRET (the API's, 32+ chars) in .env; MIXREC_API_URL defaults to https://webinarliv.com.
# Needs MediaMTX, so only alongside docker-compose.egress.yml. Without it the API records an
# edge webinar with a compositor of its own, as before.
MIXREC=0
MIXREC_SECRET_VALUE="$(env_value MIXREC_SECRET)"
if [[ -n "$MIXREC_SECRET_VALUE" ]]; then
  if (( ${#MIXREC_SECRET_VALUE} < 32 )); then
    echo "MIXREC_SECRET is under 32 characters; the mix recorder not started" >&2
  elif [[ ! -f docker-compose.mixrec.yml || ! -f mixrec/Dockerfile || ! -f docker-compose.egress.yml || ! -f egress.yaml ]]; then
    echo "MIXREC_SECRET set but docker-compose.mixrec.yml, mixrec/ or docker-compose.egress.yml is missing; sync deploy files" >&2
  else
    umask 077
    {
      echo "MIXREC_SECRET=${MIXREC_SECRET_VALUE}"
      echo "MIXREC_API_URL=$(env_value MIXREC_API_URL | sed 's|/*$||' | grep . || echo https://webinarliv.com)"
    } >mixrec.env
    umask 022
    mkdir -p recordings
    COMPOSE_ARGS+=("-f" "docker-compose.mixrec.yml")
    MIXREC=1
  fi
fi
if [[ "$MIXREC" != 1 ]]; then
  docker ps -aq --filter label=com.docker.compose.service=mixrec | xargs -r docker rm -f >/dev/null
  rm -f mixrec.env
fi

# Grafana Alloy (docker-compose.alloy.yml, alloy/config.alloy): metrics and container logs to
# Grafana Cloud. Opt-in: all five GRAFANA_CLOUD_* lines in .env (the deploy workflow writes them
# from the repo's variables and secret). Any missing: Alloy is not run, and an old one is removed.
# ALLOY_BOX in .env names this box in Grafana (the `box` label); the hostname when unset.
ALLOY=0
ALLOY_KEYS=(GRAFANA_CLOUD_PROM_URL GRAFANA_CLOUD_PROM_USER GRAFANA_CLOUD_LOKI_URL GRAFANA_CLOUD_LOKI_USER GRAFANA_CLOUD_TOKEN)
alloy_missing=()
for k in "${ALLOY_KEYS[@]}"; do
  [[ -n "$(env_value "$k")" ]] || alloy_missing+=("$k")
done
if (( ${#alloy_missing[@]} == ${#ALLOY_KEYS[@]} )); then
  : # Not configured: nothing to say.
elif (( ${#alloy_missing[@]} > 0 )); then
  echo "Grafana Cloud partly configured (missing ${alloy_missing[*]} in .env); Alloy not started" >&2
elif [[ ! -f docker-compose.alloy.yml || ! -f alloy/config.alloy ]]; then
  echo "GRAFANA_CLOUD_* set but docker-compose.alloy.yml or alloy/config.alloy is missing; sync deploy files" >&2
else
  ALLOY_BOX="$(env_value ALLOY_BOX)"
  ALLOY_BOX="${ALLOY_BOX:-$(hostname -s)}"
  umask 077
  {
    for k in "${ALLOY_KEYS[@]}"; do echo "${k}=$(env_value "$k")"; done
    echo "ALLOY_BOX=${ALLOY_BOX}"
  } >alloy.env
  umask 022
  COMPOSE_ARGS+=("-f" "docker-compose.alloy.yml")
  ALLOY=1
fi
if [[ "$ALLOY" != 1 ]]; then
  docker ps -aq --filter label=com.docker.compose.service=alloy | xargs -r docker rm -f >/dev/null
  rm -f alloy.env
fi

TURN443=0
if [[ "$TURN_TLS_443" == "true" ]]; then
  # Swaps the caddy image (built here from ./caddy-l4) and its Caddyfile; see above.
  COMPOSE_ARGS+=("-f" "docker-compose.turn443.yml")
  export TURN_TLS_DOMAIN
  TURN443=1
fi

if [[ "${DATA_COMPOSE:-0}" == 1 ]]; then
  COMPOSE_ARGS+=("-f" "docker-compose.data.yml")
fi

BUILD_SERVICES=()
if [[ "$TURN443" == 1 ]]; then
  # A few minutes the first time (xcaddy), cached after that.
  BUILD_SERVICES+=(caddy)
fi
if [[ "$CAPTIONS" == 1 && -z "$(env_value CAPTIONS_IMAGE)" ]]; then
  # Built here from ./captions; the first build takes a few minutes, later ones are cached.
  BUILD_SERVICES+=(captions)
fi
if [[ "$MIXREC" == 1 && -z "$(env_value MIXREC_IMAGE)" ]]; then
  BUILD_SERVICES+=(mixrec)
fi
if (( ${#BUILD_SERVICES[@]} > 0 )); then
  docker compose "${COMPOSE_ARGS[@]}" build "${BUILD_SERVICES[@]}"
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
# alloy/config.alloy is bind-mounted too, and read at start.
if [[ "$ALLOY" == 1 ]]; then
  docker compose "${COMPOSE_ARGS[@]}" restart alloy
fi

# TURN/TLS health: LiveKit's plain TURN listener behind Caddy, then the path through :443
# with the TURN SNI and a certificate that verifies for that name. Warn only: on the first
# enable the certificate can take a minute, and nothing else on the box depends on this.
if [[ "$TURN443" == 1 ]]; then
  turn_ok=0
  for _ in $(seq 1 12); do
    if ss -Hltn 'sport = :5349' | grep -q . &&
      timeout 5 openssl s_client -connect 127.0.0.1:443 -servername "$TURN_TLS_DOMAIN" \
        -verify_hostname "$TURN_TLS_DOMAIN" -verify_return_error </dev/null >/dev/null 2>&1; then
      turn_ok=1
      break
    fi
    sleep 5
  done
  if [[ "$turn_ok" == 1 ]]; then
    echo "TURN over TLS: turns:${TURN_TLS_DOMAIN}:443?transport=tcp (certificate verifies)"
  else
    echo "TURN over TLS: no verified certificate for ${TURN_TLS_DOMAIN} on :443 yet, or LiveKit not listening on :5349; see docker compose logs caddy livekit" >&2
  fi
fi

# The API's background pass, once a minute (TICK_URL and TICK_SECRET in .env).
#
# Cloud Run scales the API to zero and gives it CPU only during requests, so its own ticker
# does not run while nobody is using the app: a simulive would not start, reminders and drips
# would wait for the next visitor. This box is always on, so it is the visitor. The secret
# stays in .env (read by the script at run time), never in the world-readable cron file. A
# second box doing the same is harmless: the API takes a lease, and the loser answers "busy".
# Either value unset: no cron, and an old one is removed.
#
# OPS_BOX=true in .env: the always-on ops droplet (deploy/ops-box) runs the tick instead, and
# this box does not, which is what an on-demand box (deleted when idle) needs.
TICK_URL="$(env_value TICK_URL)"
if [[ "$(env_value OPS_BOX)" == "true" ]]; then
  rm -f /etc/cron.d/webinarliv-tick "${TARGET}/tick.sh"
  echo "API tick: run by the ops box (OPS_BOX=true), not here"
elif [[ -n "$TICK_URL" && -n "$(env_value TICK_SECRET)" ]]; then
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
if [[ "$MIXREC" == 1 ]]; then
  echo "Mix recorder: on (https://${DOMAIN}/mixrec/v1/health; docker compose logs mixrec)"
fi
if [[ "$ALLOY" == 1 ]]; then
  echo "Grafana Cloud: Alloy on, box=${ALLOY_BOX} (docker compose logs alloy)"
fi
echo "Grafana: https://${DOMAIN}/grafana/ (user: admin, password in ${TARGET}/.env.keys)"
