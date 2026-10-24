#!/usr/bin/env bash
# First boot of an on-demand captions droplet (deploy/digitalocean/README.md "Captions box").
#
# The API creates the droplet from the newest 'webinar-captions-image' snapshot together with the
# video box (api/internal/api/captions_box.go). Its user data writes /etc/webinarliv/captions.env
# (the video box's LiveKit URL, key and secret, CAPTIONS_SECRET and the agent's size settings),
# then fetches this script from the repo and runs it; the snapshot carries a copy at
# /usr/local/sbin/webinarliv-captions-boot.sh for when GitHub cannot be reached. It:
#
#   1. syncs deploy/captions from the repo at CAPTIONS_REF into /opt/captions (a failure keeps
#      the snapshot's copy);
#   2. rebuilds the agent image from it: the snapshot holds the build cache (Python packages and
#      the baked models), so an unchanged agent is all cache hits and a code change takes seconds;
#   3. starts the agent (docker-compose.captions-box.yml). It connects out to the video box's
#      LiveKit and registers as a worker; the API dispatches it to rooms as before.
#
# No volume, no state: the droplet is deleted with the video box. Output goes to
# /var/log/webinarliv-captions-boot.log. Safe to run again by hand. Never prints the env file.
set -euo pipefail

REPO="${CAPTIONS_REPO:-netesh3/webinar}"
REF="${CAPTIONS_REF:-main}"
SRC=/opt/captions
BOX=/opt/captions-box
ENV_FILE=/etc/webinarliv/captions.env
# The models the snapshot baked into the image (build-captions-image.sh). The same build arg, or
# the seed layer would be rebuilt and download them again.
SEED_MODELS="$(cat /etc/webinarliv-captions-seed 2>/dev/null || echo base.en)"

log() { echo "$(date -u +%FT%TZ) captions-boot: $*"; }

if [[ ! -s "$ENV_FILE" ]]; then
  log "no ${ENV_FILE}: the API's user data did not run; nothing to start"
  exit 1
fi
chmod 600 "$ENV_FILE"

# 1. The latest agent. The repo is public.
tmp="$(mktemp -d)"
if curl -fsSL --retry 5 --retry-delay 3 -m 180 "https://codeload.github.com/${REPO}/tar.gz/${REF}" |
  tar -xz -C "$tmp" --strip-components=1 --wildcards '*/deploy/captions/*' '*/deploy/digitalocean/*'; then
  mkdir -p "$SRC" "$BOX"
  rsync -a --delete --exclude 'tests' --exclude '__pycache__' --exclude '.pytest_cache' \
    "${tmp}/deploy/captions/" "${SRC}/"
  install -m 644 "${tmp}/deploy/digitalocean/docker-compose.captions-box.yml" "${BOX}/docker-compose.yml"
  install -m 755 "${tmp}/deploy/digitalocean/captions-boot.sh" /usr/local/sbin/webinarliv-captions-boot.sh
  log "agent synced from ${REPO}@${REF}"
else
  log "could not fetch ${REPO}@${REF}; starting the snapshot's agent"
fi
rm -rf "$tmp"

systemctl start docker

# 2. The image (cached unless the agent changed).
if ! docker build -q --build-arg "CAPTIONS_SEED_MODELS=${SEED_MODELS}" -t webinarliv-captions:local "$SRC" >/dev/null; then
  log "image build failed; starting the snapshot's image"
fi

# 3. The agent. CAPTIONS_CPUS is the compose file's cpus cap too.
cpus="$(grep -E '^CAPTIONS_CPUS=[0-9]+$' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
export CAPTIONS_CPUS="${cpus:-2}"
cd "$BOX"
docker compose -p captions up -d --remove-orphans
log "caption agent up (docker compose -p captions logs -f)"
