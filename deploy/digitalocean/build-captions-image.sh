#!/usr/bin/env bash
# Builds what the 'webinar-captions-image' snapshot carries, on a throwaway droplet, then powers it
# off (.github/workflows/sfu-snapshot.yml snapshots it once it is off, and deletes it). The image
# of the on-demand captions box (deploy/digitalocean/README.md "Captions box").
#
# Run as the builder droplet's user data, from fresh Ubuntu 24.04, with SFU_REPO / SFU_REF set
# (the workflow prepends them). No state and no secrets: Docker, a host firewall that lets nothing
# in but SSH, the caption agent's image built from the repo with base.en and large-v3-turbo baked
# in (so a new box neither downloads a model nor waits on Hugging Face), the compose file and the
# boot script. The LiveKit key and CAPTIONS_SECRET arrive in each droplet's user data.
#
# On failure it does NOT power off, so the workflow times out and deletes the builder instead of
# snapshotting a half-built image. Log: /var/log/webinarliv-build.log.
set -euo pipefail
exec >>/var/log/webinarliv-build.log 2>&1

REPO="${SFU_REPO:-netesh3/webinar}"
REF="${SFU_REF:-main}"
# Baked into the image: the live model and the after-session one (~1.8 GB). captions-boot.sh
# rebuilds with the same list (from /etc/webinarliv-captions-seed) so the layer stays cached.
SEED_MODELS="base.en large-v3-turbo"
log() { echo "$(date -u +%FT%TZ) build-captions-image: $*"; }

export DEBIAN_FRONTEND=noninteractive
log "packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw rsync
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Nothing listens for the outside: the agent only connects out (LiveKit, the API, GitHub).
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

log "agent from ${REPO}@${REF}"
src=/opt/webinarliv-build
rm -rf "$src"
mkdir -p "$src" /opt/captions /opt/captions-box
curl -fsSL --retry 5 -m 300 "https://codeload.github.com/${REPO}/tar.gz/${REF}" |
  tar -xz -C "$src" --strip-components=1 --wildcards '*/deploy/captions/*' '*/deploy/digitalocean/*'
rsync -a --delete --exclude 'tests' --exclude '__pycache__' --exclude '.pytest_cache' \
  "${src}/deploy/captions/" /opt/captions/
install -m 644 "${src}/deploy/digitalocean/docker-compose.captions-box.yml" /opt/captions-box/docker-compose.yml
install -m 755 "${src}/deploy/digitalocean/captions-boot.sh" /usr/local/sbin/webinarliv-captions-boot.sh
echo "$SEED_MODELS" >/etc/webinarliv-captions-seed

log "image"
docker build --build-arg "CAPTIONS_SEED_MODELS=${SEED_MODELS}" -t webinarliv-captions:local /opt/captions

log "clean"
cd /
rm -rf "$src"
docker container prune -f
docker volume prune -af || docker volume prune -f
apt-get clean
rm -f /root/.ssh/authorized_keys
cloud-init clean --logs || true
journalctl --vacuum-time=1s || true
echo "captions ${REPO}@${REF} $(date -u +%FT%TZ)" >/etc/webinarliv-image
sync
log "done; powering off for the snapshot"
poweroff
