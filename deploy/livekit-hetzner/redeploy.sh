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
# Caddyfile is bind-mounted, so `up -d` alone does not make Caddy pick up
# edits to it — the config-hash docker compose diffs against is the compose
# service definition, not the mounted file's content, and Caddy itself only
# reads Caddyfile at process start (no live-reload without an explicit
# `caddy reload`). Restart it unconditionally on every redeploy instead of
# depending on that heuristic to happen to also recreate the container.
docker compose restart caddy

echo "LiveKit redeployed at wss://${DOMAIN} (keys unchanged in ${TARGET}/.env.keys)"
echo "Grafana: https://${DOMAIN}/grafana/ (user: admin, password in ${TARGET}/.env.keys)"
