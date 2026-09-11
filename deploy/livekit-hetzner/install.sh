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

# Persist secrets once
if [[ -f "$TARGET/.env.keys" ]]; then
  # shellcheck disable=SC1091
  source "$TARGET/.env.keys"
else
  cat >"$TARGET/.env.keys" <<EOF
API_KEY=$API_KEY
API_SECRET=$API_SECRET
DOMAIN=$DOMAIN
EOF
  chmod 600 "$TARGET/.env.keys"
fi
# shellcheck disable=SC1091
source "$TARGET/.env.keys"

sed -e "s/__TURN_DOMAIN__/${DOMAIN}/g" \
    -e "s/__API_KEY__/${API_KEY}/g" \
    -e "s/__API_SECRET__/${API_SECRET}/g" \
    livekit.yaml.template > livekit.yaml

cat >.env <<EOF
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF

docker compose pull
docker compose up -d

echo
echo "LiveKit URL:  wss://${DOMAIN}"
echo "API Key:      ${API_KEY}"
echo "API Secret:   (in ${TARGET}/.env.keys)"
echo "Compose:      ${TARGET}"
