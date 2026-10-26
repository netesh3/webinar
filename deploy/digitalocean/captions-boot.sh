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
#      LiveKit and registers as a worker; the API dispatches it to rooms as before;
#   4. with the API's Grafana Cloud settings (/etc/webinarliv/grafana.env, all five
#      GRAFANA_CLOUD_* lines), starts Grafana Alloy beside it (the video box's
#      docker-compose.alloy.yml with alloy/captions.alloy): host, container and agent metrics
#      and container logs, labelled box=<hostname> and role=captions. Without them, no Alloy.
#
# No volume, no state: the droplet is deleted with the video box. Output goes to
# /var/log/webinarliv-captions-boot.log. Safe to run again by hand. Never prints the env file.
set -euo pipefail

REPO="${CAPTIONS_REPO:-netesh3/webinar}"
REF="${CAPTIONS_REF:-main}"
SRC=/opt/captions
BOX=/opt/captions-box
ENV_FILE=/etc/webinarliv/captions.env
# Written by the user data only when the API has all five GRAFANA_CLOUD_* (captionsUserData).
GRAFANA_FILE=/etc/webinarliv/grafana.env
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
  tar -xz -C "$tmp" --strip-components=1 --wildcards '*/deploy/captions/*' '*/deploy/digitalocean/*' \
    '*/deploy/livekit-box/docker-compose.alloy.yml'; then
  mkdir -p "$SRC" "$BOX" "${BOX}/alloy"
  rsync -a --delete --exclude 'tests' --exclude '__pycache__' --exclude '.pytest_cache' \
    "${tmp}/deploy/captions/" "${SRC}/"
  install -m 644 "${tmp}/deploy/digitalocean/docker-compose.captions-box.yml" "${BOX}/docker-compose.yml"
  install -m 755 "${tmp}/deploy/digitalocean/captions-boot.sh" /usr/local/sbin/webinarliv-captions-boot.sh
  install -m 644 "${tmp}/deploy/livekit-box/docker-compose.alloy.yml" "${BOX}/docker-compose.alloy.yml"
  install -m 644 "${tmp}/deploy/digitalocean/alloy/captions.alloy" "${BOX}/alloy/config.alloy"
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
COMPOSE_ARGS=(-p captions -f docker-compose.yml)

# 4. Grafana Alloy, only with all five GRAFANA_CLOUD_* lines (each a plain value) and nothing
# else in the file, as sfu-boot.sh checks them. alloy.env (root, 0600) is those lines plus
# ALLOY_BOX, the hostname (the droplet's name, e.g. captions-blr-1). Values are never printed.
# Without the file (or with a bad one) Alloy is not started, and --remove-orphans removes one
# left from an earlier run.
alloy=0
if [[ -f "$GRAFANA_FILE" ]]; then
  ok=1
  for k in GRAFANA_CLOUD_PROM_URL GRAFANA_CLOUD_PROM_USER GRAFANA_CLOUD_LOKI_URL GRAFANA_CLOUD_LOKI_USER GRAFANA_CLOUD_TOKEN; do
    grep -qE "^${k}=[A-Za-z0-9._:/@+=%?&,~-]+$" "$GRAFANA_FILE" || ok=0
  done
  if grep -vqE '^GRAFANA_CLOUD_(PROM_URL|PROM_USER|LOKI_URL|LOKI_USER|TOKEN)=' "$GRAFANA_FILE"; then
    ok=0
  fi
  if [[ "$ok" != 1 ]]; then
    log "ignoring ${GRAFANA_FILE}: not the five GRAFANA_CLOUD_* lines; Alloy not started"
  elif [[ ! -f docker-compose.alloy.yml || ! -f alloy/config.alloy ]]; then
    log "Grafana Cloud configured but docker-compose.alloy.yml or alloy/config.alloy is missing; Alloy not started"
  else
    chmod 600 "$GRAFANA_FILE"
    box="$(hostname -s)"
    rm -f alloy.env.tmp
    (
      umask 077
      { cat "$GRAFANA_FILE"; echo "ALLOY_BOX=${box}"; } >alloy.env.tmp
    )
    mv alloy.env.tmp alloy.env
    COMPOSE_ARGS+=(-f docker-compose.alloy.yml)
    alloy=1
  fi
fi
if [[ "$alloy" != 1 ]]; then
  rm -f alloy.env
fi

docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans
log "caption agent up (docker compose -p captions logs -f)"
if [[ "$alloy" == 1 ]]; then
  log "Grafana Cloud: Alloy on, box=${box} role=captions (docker compose -p captions logs alloy)"
fi
