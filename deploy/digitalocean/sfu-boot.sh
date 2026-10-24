#!/usr/bin/env bash
# First boot of an on-demand video server droplet (deploy/digitalocean/README.md).
#
# The API creates the droplet from the newest 'webinar-sfu-image' snapshot with the 'sfu-data'
# volume attached, and its user data (api/internal/api/sfu_box.go, boxUserData) fetches this
# script from the repo and runs it; the snapshot carries a copy at
# /usr/local/sbin/webinarliv-sfu-boot.sh for when GitHub cannot be reached. It:
#
#   1. mounts the volume at SFU_DATA_DIR (/mnt/sfu-data) and adds it to fstab;
#   2. makes /opt/livekit the volume's livekit/ directory (keys, .env, livekit.yaml, recordings);
#   3. adds the deploy keys kept on the volume (ssh/authorized_keys) for the deploy workflow;
#   4. syncs the latest deploy files from the repo at SFU_REF, as the deploy workflow does, so a
#      box that was down during a deploy still comes up current;
#   5. merges the Grafana Cloud settings the API passed in the user data (SFU_GRAFANA_ENV) into
#      .env, so Alloy reports from first boot, and records whether captions run on the separate
#      captions box (SFU_CAPTIONS_REMOTE → CAPTIONS_REMOTE in .env: then this box runs none);
#   6. runs redeploy.sh with SFU_DATA_DIR and OPS_BOX=true (the ops box runs the API tick).
#
# Docker, the images and the host firewall come from the snapshot (build-image.sh). Output goes to
# /var/log/webinarliv-boot.log. Safe to run again by hand.
set -euo pipefail

DATA="${SFU_DATA_DIR:-/mnt/sfu-data}"
VOLUME="${SFU_VOLUME_NAME:-sfu-data}"
REPO="${SFU_REPO:-netesh3/webinar}"
REF="${SFU_REF:-main}"
TARGET=/opt/livekit

log() { echo "$(date -u +%FT%TZ) sfu-boot: $*"; }

# 1. The volume. DigitalOcean exposes it by name; it can take a few seconds to appear.
dev="/dev/disk/by-id/scsi-0DO_Volume_${VOLUME}"
for _ in $(seq 1 90); do
  [[ -e "$dev" ]] && break
  sleep 2
done
if [[ ! -e "$dev" ]]; then
  log "volume ${VOLUME} is not attached (${dev}); the stack cannot start without it"
  exit 1
fi
mkdir -p "$DATA"
if ! mountpoint -q "$DATA"; then
  mount -o discard,defaults,noatime "$dev" "$DATA"
fi
if ! grep -qs " ${DATA} " /etc/fstab; then
  echo "${dev} ${DATA} ext4 defaults,nofail,discard,noatime 0 2" >>/etc/fstab
fi
if [[ ! -f "${DATA}/livekit/.env" || ! -f "${DATA}/livekit/.env.keys" ]]; then
  log "no ${DATA}/livekit/.env or .env.keys: run the one-time setup in deploy/digitalocean/README.md"
  exit 1
fi

# 2. /opt/livekit is the volume's livekit/.
if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
  mv "$TARGET" "${TARGET}.snapshot-$(date +%s)"
fi
ln -sfn "${DATA}/livekit" "$TARGET"

# 3. Deploy keys (the deploy workflow's DO_SSH_PRIVATE_KEY, and whoever else should get in).
if [[ -f "${DATA}/ssh/authorized_keys" ]]; then
  install -d -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  while IFS= read -r key; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    grep -qxF "$key" /root/.ssh/authorized_keys || echo "$key" >>/root/.ssh/authorized_keys
  done <"${DATA}/ssh/authorized_keys"
  chmod 600 /root/.ssh/authorized_keys
fi

# 4. The latest deploy files. The repo is public; a failure keeps what the volume already has.
tmp="$(mktemp -d)"
if curl -fsSL --retry 5 --retry-delay 3 -m 180 "https://codeload.github.com/${REPO}/tar.gz/${REF}" |
  tar -xz -C "$tmp" --strip-components=1 --wildcards \
    '*/deploy/livekit-hetzner/*' '*/deploy/captions/*' '*/deploy/digitalocean/*'; then
  rsync -a --exclude '.env' --exclude '.env.keys' --exclude 'livekit.yaml' --exclude 'recordings' \
    "${tmp}/deploy/livekit-hetzner/" "${TARGET}/"
  rsync -a --delete --exclude 'tests' --exclude '__pycache__' --exclude '.pytest_cache' \
    "${tmp}/deploy/captions/" "${TARGET}/captions/"
  install -m 755 "${tmp}/deploy/digitalocean/sfu-boot.sh" /usr/local/sbin/webinarliv-sfu-boot.sh
  log "deploy files synced from ${REPO}@${REF}"
else
  log "could not fetch ${REPO}@${REF}; starting with the deploy files already on the volume"
fi
rm -rf "$tmp"

# 5. What an on-demand box needs in .env, then the stack.
set_env() { grep -q "^$1=" "${TARGET}/.env" || echo "$1=$2" >>"${TARGET}/.env"; }
set_env SFU_DATA_DIR "$DATA"
set_env OPS_BOX true

# Grafana Cloud for Alloy, from the API (user data writes SFU_GRAFANA_ENV; boxUserData in
# api/internal/api/sfu_box.go). All five GRAFANA_CLOUD_* lines replace the ones in .env, as the
# deploy workflow does, so the API's settings win and running this again changes nothing. A file
# that is not all five plain KEY=value lines is ignored. Values are never printed.
GRAFANA_KEYS="GRAFANA_CLOUD_PROM_URL GRAFANA_CLOUD_PROM_USER GRAFANA_CLOUD_LOKI_URL GRAFANA_CLOUD_LOKI_USER GRAFANA_CLOUD_TOKEN"
grafana_file="${SFU_GRAFANA_ENV:-}"
if [[ -n "$grafana_file" && -f "$grafana_file" ]]; then
  ok=1
  for k in $GRAFANA_KEYS; do
    grep -qE "^${k}=[A-Za-z0-9._:/@+=%?&,~-]+$" "$grafana_file" || ok=0
  done
  if [[ "$ok" == 1 ]] && ! grep -vqE '^GRAFANA_CLOUD_(PROM_URL|PROM_USER|LOKI_URL|LOKI_USER|TOKEN)=' "$grafana_file"; then
    tmp_env="$(mktemp "${TARGET}/.env.XXXXXX")"
    grep -vE '^GRAFANA_CLOUD_(PROM_URL|PROM_USER|LOKI_URL|LOKI_USER|TOKEN)=' "${TARGET}/.env" >"$tmp_env" || :
    cat "$grafana_file" >>"$tmp_env"
    chmod --reference="${TARGET}/.env" "$tmp_env" 2>/dev/null || chmod 600 "$tmp_env"
    mv "$tmp_env" "${TARGET}/.env"
    log "Grafana Cloud settings from the API written to .env (Alloy starts with the stack)"
  else
    log "ignoring ${grafana_file}: not the five GRAFANA_CLOUD_* lines"
  fi
  rm -f "$grafana_file"
fi

# Captions on the separate captions box (CAPTIONS_BOX_ENABLED on the API; captions_box.go): the
# API says so in SFU_CAPTIONS_REMOTE, and redeploy.sh then leaves this box's caption agent off
# (CAPTIONS_REMOTE=true in .env; the deploy workflow's redeploy reads the same line). User data
# from an API before this setting leaves .env as it is.
case "${SFU_CAPTIONS_REMOTE:-}" in
  true | false)
    tmp_env="$(mktemp "${TARGET}/.env.XXXXXX")"
    grep -v '^CAPTIONS_REMOTE=' "${TARGET}/.env" >"$tmp_env" || :
    [[ "$SFU_CAPTIONS_REMOTE" == true ]] && echo "CAPTIONS_REMOTE=true" >>"$tmp_env"
    chmod --reference="${TARGET}/.env" "$tmp_env" 2>/dev/null || chmod 600 "$tmp_env"
    mv "$tmp_env" "${TARGET}/.env"
    log "captions: $([[ "$SFU_CAPTIONS_REMOTE" == true ]] && echo 'on the captions box, not here' || echo 'as .env says')"
    ;;
esac

systemctl start docker
chmod +x "${TARGET}/redeploy.sh" "${TARGET}/install.sh"
"${TARGET}/redeploy.sh"
log "stack up"
