#!/usr/bin/env bash
# Install Docker + LiveKit on a fresh Ubuntu box (run as root).
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN e.g. 88.198.141.104.sslip.io}"
ACME_EMAIL="${ACME_EMAIL:?set ACME_EMAIL}"
TARGET="${TARGET:-/opt/livekit}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw openssl

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Host firewall (cloud firewall is separate)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 50000:60000/udp
ufw --force enable

mkdir -p "$TARGET"
cd "$TARGET"

API_KEY="API$(openssl rand -hex 8)"
API_SECRET="$(openssl rand -hex 32)"
GRAFANA_ADMIN_PASSWORD="$(openssl rand -hex 16)"

# Persist secrets once — never rotate on reinstall/redeploy
if [[ -f "$TARGET/.env.keys" ]]; then
  # shellcheck disable=SC1091
  source "$TARGET/.env.keys"
  if [[ -z "${GRAFANA_ADMIN_PASSWORD:-}" ]]; then
    # Upgrading a host installed before Grafana was added.
    echo "GRAFANA_ADMIN_PASSWORD=$GRAFANA_ADMIN_PASSWORD" >>"$TARGET/.env.keys"
  fi
else
  cat >"$TARGET/.env.keys" <<EOF
API_KEY=$API_KEY
API_SECRET=$API_SECRET
DOMAIN=$DOMAIN
GRAFANA_ADMIN_PASSWORD=$GRAFANA_ADMIN_PASSWORD
EOF
  chmod 600 "$TARGET/.env.keys"
fi
# shellcheck disable=SC1091
source "$TARGET/.env.keys"

# .env holds Caddy ACME vars; keep existing email/domain on re-run if present
if [[ ! -f .env ]]; then
  cat >.env <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF
fi

# Render yaml (preserves node_ip / use_external_ip) and start stack
chmod +x "$TARGET/redeploy.sh"
"$TARGET/redeploy.sh"

echo
echo "LiveKit URL:  wss://${DOMAIN}"
echo "API Key:      ${API_KEY}"
echo "API Secret:   (in ${TARGET}/.env.keys)"
echo "Grafana:      https://${DOMAIN}/grafana/ (user: admin, password in ${TARGET}/.env.keys)"
echo "Compose:      ${TARGET}"
