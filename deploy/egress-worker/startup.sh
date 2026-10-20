#!/usr/bin/env bash
# Egress worker: LiveKit Egress only (headless Chrome + encoder), for one Edge webinar at a time.
#
# Runs as the VM's GCE startup script, on EVERY boot (workers are kept stopped and started by
# the API when a host clicks Start). Everything it needs comes from instance metadata, which
# .github/workflows/egress-pool.yml sets:
#
#   sfu-domain        public hostname of the SFU box, for ws_url (wss://<domain>)
#   sfu-private-ip    the SFU box on the VPC: Redis :6379, and MediaMTX RTMP :1935 (forwarded
#                     from the worker's own 127.0.0.1:1935, where the API tells egress to push)
#   lk-api-key        that SFU's LiveKit key and secret
#   lk-api-secret
#   redis-password    REDIS_PASSWORD from the SFU box's /opt/livekit/.env.keys
#
# The first boot installs Docker and pulls the image (a few minutes); later boots only rewrite
# the config and start the container, about a minute from power-on to taking a job.
set -euo pipefail

md() { curl -fsS -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
SFU_DOMAIN="$(md sfu-domain)"
SFU_PRIVATE_IP="$(md sfu-private-ip)"
LK_API_KEY="$(md lk-api-key)"
LK_API_SECRET="$(md lk-api-secret)"
REDIS_PASSWORD="$(md redis-password)"

if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

mkdir -p /opt/egress
cd /opt/egress
umask 077
# Written beside the live files and swapped in only when different. Docker restarts the
# egress container on its own at boot, and it can take a webinar's job within seconds;
# recreating it then (as this script used to on every boot) killed that mix mid-start
# (2026-10-20). So the container is recreated only when its config really changed.
cat >egress.yaml.new <<YAML
api_key: ${LK_API_KEY}
api_secret: ${LK_API_SECRET}
ws_url: wss://${SFU_DOMAIN}
redis:
  address: ${SFU_PRIVATE_IP}:6379
  password: "${REDIS_PASSWORD}"
log_level: info
health_port: 8080
# One composite per worker: a 1080p30 mix needs most of a 4-vCPU box, and a second one would
# make both stutter. Reserving 2.5 CPUs per composite under a 90% ceiling admits the first job
# on 4 vCPUs and refuses the next, so LiveKit hands it to another worker instead.
cpu_cost:
  max_cpu_utilization: 0.9
  room_composite_cpu_cost: 2.5
  web_cpu_cost: 2.5
YAML
chmod 644 egress.yaml.new

cat >docker-compose.yml.new <<'YAML'
services:
  egress:
    image: livekit/egress:v1.15.0
    network_mode: host
    restart: unless-stopped
    environment:
      EGRESS_CONFIG_FILE: /etc/egress.yaml
    cap_add:
      - SYS_ADMIN
    volumes:
      - ./egress.yaml:/etc/egress.yaml:ro
      - /dev/shm:/dev/shm
  # The API hands every egress BROADCAST_RTMP_BASE (rtmp://127.0.0.1:1935/live), which is
  # right on an SFU box with MediaMTX beside it. Here 127.0.0.1 is the worker, so forward that
  # port to the SFU box's MediaMTX over the VPC: the API needs no per-worker address.
  rtmp-forward:
    image: alpine/socat:1.8.0.3
    network_mode: host
    restart: unless-stopped
    command: ["TCP-LISTEN:1935,bind=127.0.0.1,fork,reuseaddr", "TCP:__SFU_PRIVATE_IP__:1935"]
YAML
sed -i "s/__SFU_PRIVATE_IP__/${SFU_PRIVATE_IP}/" docker-compose.yml.new

changed=0
for f in egress.yaml docker-compose.yml; do
  if ! cmp -s "$f.new" "$f"; then mv "$f.new" "$f"; changed=1; else rm -f "$f.new"; fi
done

# Pull only what is missing: a boot is about a minute from a webinar waiting on it.
docker image inspect livekit/egress:v1.15.0 >/dev/null 2>&1 && docker image inspect alpine/socat:1.8.0.3 >/dev/null 2>&1 \
  || docker compose pull --quiet
if [[ "$changed" == 1 ]]; then
  docker compose up -d --force-recreate
else
  docker compose up -d
fi
echo "egress worker up: wss://${SFU_DOMAIN}, redis ${SFU_PRIVATE_IP}:6379, rtmp 127.0.0.1:1935 -> ${SFU_PRIVATE_IP}:1935"
