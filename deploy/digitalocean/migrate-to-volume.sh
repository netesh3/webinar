#!/usr/bin/env bash
# One-time: move the running video server's state onto the sfu-data volume
# (deploy/digitalocean/README.md, "One-time setup", step 2). Run as root on sfu-blr-1 after the
# volume is attached, while NOTHING is live on the box: it stops and restarts the stack.
#
#   /opt/livekit                    -> /mnt/sfu-data/livekit   (keys, .env, livekit.yaml, recordings)
#   docker volumes caddy_data,      -> /mnt/sfu-data/docker/…  (certificates, caption models and spool)
#     caddy_config, captions_models,
#     captions_spool
#   /root/.ssh/authorized_keys      -> /mnt/sfu-data/ssh/authorized_keys (the deploy key, for new droplets)
#
# then /opt/livekit becomes a link to the volume, SFU_DATA_DIR is set in .env, and redeploy.sh
# brings the stack back on the volume. The old directory is kept as /opt/livekit.pre-volume.
# OPS_BOX=true (env) also sets OPS_BOX in .env, which stops this box's tick cron: only once the
# ops box is ticking.
set -euo pipefail

DATA="${SFU_DATA_DIR:-/mnt/sfu-data}"
VOLUME="${SFU_VOLUME_NAME:-sfu-data}"
SRC=/opt/livekit
dev="/dev/disk/by-id/scsi-0DO_Volume_${VOLUME}"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -e "$dev" ]] || { echo "volume ${VOLUME} is not attached (${dev})" >&2; exit 1; }
if [[ -L "$SRC" ]]; then
  echo "${SRC} is already a link ($(readlink "$SRC")): nothing to migrate" >&2
  exit 0
fi
[[ -f "${SRC}/.env.keys" ]] || { echo "no ${SRC}/.env.keys: is this the video server?" >&2; exit 1; }

mkdir -p "$DATA"
mountpoint -q "$DATA" || mount -o discard,defaults,noatime "$dev" "$DATA"
grep -qs " ${DATA} " /etc/fstab || echo "${dev} ${DATA} ext4 defaults,nofail,discard,noatime 0 2" >>/etc/fstab

echo "Stopping the stack"
docker ps -q --filter label=com.docker.compose.project=livekit | xargs -r docker stop >/dev/null

echo "Copying ${SRC} and the docker volumes onto ${DATA}"
mkdir -p "${DATA}/livekit" "${DATA}/ssh"
rsync -a "${SRC}/" "${DATA}/livekit/"
for v in caddy_data caddy_config captions_models captions_spool; do
  mkdir -p "${DATA}/docker/${v}"
  src="/var/lib/docker/volumes/livekit_${v}/_data"
  if [[ -d "$src" ]]; then
    rsync -a "${src}/" "${DATA}/docker/${v}/"
  fi
done
if [[ -f /root/.ssh/authorized_keys ]]; then
  cp /root/.ssh/authorized_keys "${DATA}/ssh/authorized_keys"
  chmod 600 "${DATA}/ssh/authorized_keys"
fi

mv "$SRC" "${SRC}.pre-volume"
ln -s "${DATA}/livekit" "$SRC"
grep -q '^SFU_DATA_DIR=' "${SRC}/.env" || echo "SFU_DATA_DIR=${DATA}" >>"${SRC}/.env"
if [[ "${OPS_BOX:-}" == "true" ]]; then
  grep -q '^OPS_BOX=' "${SRC}/.env" || echo "OPS_BOX=true" >>"${SRC}/.env"
fi

echo "Starting the stack on the volume"
cd "$SRC"
./redeploy.sh
echo "Done. Old files kept in ${SRC}.pre-volume; remove them once the box has run a session."
