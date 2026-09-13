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

# shellcheck disable=SC1091
source .env.keys

: "${API_KEY:?API_KEY missing in .env.keys}"
: "${API_SECRET:?API_SECRET missing in .env.keys}"
: "${DOMAIN:?DOMAIN missing in .env.keys}"
: "${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD missing in .env.keys — rerun install.sh to add it}"
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

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

sed -e "s/__TURN_DOMAIN__/${DOMAIN}/g" \
    -e "s/__API_KEY__/${API_KEY}/g" \
    -e "s/__API_SECRET__/${API_SECRET}/g" \
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

umask 077
mv "$tmp" livekit.yaml
trap - EXIT

docker compose pull
docker compose up -d

echo "LiveKit redeployed at wss://${DOMAIN} (keys unchanged in ${TARGET}/.env.keys)"
