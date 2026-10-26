#!/usr/bin/env bash
# Builds what the 'webinar-sfu-image' snapshot carries, on a throwaway droplet, then powers it off
# (.github/workflows/sfu-snapshot.yml snapshots it once it is off, and deletes it).
#
# Run as the builder droplet's user data, from fresh Ubuntu 24.04, with SFU_REPO / SFU_REF set
# (the workflow prepends them). The snapshot holds no state and no secrets: just Docker, the
# host firewall, every image the stack runs (pulled, or built from the repo at SFU_REF: mixrec,
# the caddy-l4 build) and the boot script. Keys and certificates are on the sfu-data volume; the
# deploy files are synced from the repo at every boot (sfu-boot.sh). No caption agent or models:
# the Whisper captions box has its own snapshot (build-captions-image.sh); only the light
# Deepgram caption worker image is built here.
#
# On failure it does NOT power off, so the workflow times out and deletes the builder instead of
# snapshotting a half-built image. Log: /var/log/webinarliv-build.log.
set -euo pipefail
exec >>/var/log/webinarliv-build.log 2>&1

REPO="${SFU_REPO:-netesh3/webinar}"
REF="${SFU_REF:-main}"
log() { echo "$(date -u +%FT%TZ) build-image: $*"; }

export DEBIAN_FRONTEND=noninteractive
log "packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw openssl rsync
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# The host firewall, as install.sh sets it (the cloud firewall sfu-media is separate).
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 50000:60000/udp
ufw --force enable

log "deploy files from ${REPO}@${REF}"
src=/opt/webinarliv-build
rm -rf "$src"
mkdir -p "$src"
curl -fsSL --retry 5 -m 300 "https://codeload.github.com/${REPO}/tar.gz/${REF}" |
  tar -xz -C "$src" --strip-components=1 --wildcards \
    '*/deploy/livekit-box/*' '*/deploy/digitalocean/*' '*/deploy/captions/*'
stack="${src}/deploy/livekit-box"

log "images"
cd "$stack"
# Placeholders only so compose can read the files; nothing is started here.
touch mixrec.env alloy.env livekit.yaml egress.yaml mediamtx.yml redis.conf
export DOMAIN=image.invalid ACME_EMAIL=image@invalid GRAFANA_ADMIN_PASSWORD=image TURN_TLS_DOMAIN=turn.image.invalid
files=(-f docker-compose.yml -f docker-compose.egress.yml -f docker-compose.mixrec.yml
  -f docker-compose.turn443.yml -f docker-compose.alloy.yml)
docker compose --profile local-egress "${files[@]}" pull --ignore-buildable
# The stock Caddy too (the turn443 file replaces it with the layer4 build, so the pull above skips it).
docker pull caddy:2-alpine
docker build -t webinarliv-mixrec:local mixrec
docker build -t webinarliv-caddy-l4:local caddy-l4
# The Deepgram caption worker (docker-compose.captions-worker.yml; ~400 MB, no models), so a
# box with captions on does not build it at first boot.
# -f is relative to the working directory, not the build context: give the full path
# (the first snapshot after #758 failed with "open Dockerfile.light: no such file").
docker build -f "${src}/deploy/captions/Dockerfile.light" -t webinarliv-captions-worker:local "${src}/deploy/captions"

install -m 755 "${src}/deploy/digitalocean/sfu-boot.sh" /usr/local/sbin/webinarliv-sfu-boot.sh

log "clean"
cd /
rm -rf "$src"
docker container prune -f
docker volume prune -af || docker volume prune -f
apt-get clean
rm -f /root/.ssh/authorized_keys
cloud-init clean --logs || true
journalctl --vacuum-time=1s || true
echo "${REPO}@${REF} $(date -u +%FT%TZ)" >/etc/webinarliv-image
sync
log "done; powering off for the snapshot"
poweroff
