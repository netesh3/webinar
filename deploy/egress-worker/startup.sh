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
#   sfu-public-ip     (optional) the SFU box's public IP: traffic to it is sent to
#                     sfu-private-ip instead, so it stays on the VPC
#
# Server-side live captions (deploy/captions), optional — all three set, or none:
#   captions-image    the caption agent image (built from deploy/captions and pushed to a
#                     registry this VM can pull from; workers have no source to build from)
#   captions-secret   CAPTIONS_SECRET, the API's
#   captions-api-url  (optional) default https://webinarliv.com
# With them the worker also runs the caption agent beside egress, capped at half the vCPUs
# with low cpu_shares and nice, so the composite keeps the CPU it was sized for.
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
SFU_PUBLIC_IP="$(md sfu-public-ip 2>/dev/null || true)"
CAPTIONS_IMAGE="$(md captions-image 2>/dev/null || true)"
CAPTIONS_SECRET="$(md captions-secret 2>/dev/null || true)"
CAPTIONS_API_URL="$(md captions-api-url 2>/dev/null || true)"

# Talk to the SFU over the VPC, not its public IP. LiveKit tells every client, this worker
# included, to send media to node_ip (public), and the signalling hostname resolves there
# too, so worker <-> SFU traffic left through Google's edge and came back — billable, for
# what is a hop inside one zone. Rewriting that destination to the private IP keeps it all
# internal; conntrack translates the replies back, so ICE and TLS see what they expect.
if [[ -n "$SFU_PUBLIC_IP" ]]; then
  iptables -t nat -C OUTPUT -d "$SFU_PUBLIC_IP" -j DNAT --to-destination "$SFU_PRIVATE_IP" 2>/dev/null \
    || iptables -t nat -A OUTPUT -d "$SFU_PUBLIC_IP" -j DNAT --to-destination "$SFU_PRIVATE_IP"
fi

if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

CPUS="$(nproc)"
if (( CPUS >= 4 )); then COMPOSITE_COST=2.5; else COMPOSITE_COST=1.5; fi

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
# One composite per worker, sized from the machine: a cost a bit over half the usable CPU
# admits the first job and refuses the next, so LiveKit hands it to another worker. Measured
# 1080p/20fps: ~1.1 cores (egress ~73%, Chrome ~30%) — so 2 vCPU carries one (2026-10-20).
# On 2 vCPU that is 1.5 under 1.8 usable; on 4, 2.5 under 3.6.
cpu_cost:
  max_cpu_utilization: 0.9
  room_composite_cpu_cost: ${COMPOSITE_COST}
  web_cpu_cost: ${COMPOSITE_COST}
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

# Server captions beside egress, when the metadata asks for them. Half the vCPUs at most
# (2 of 4, 1 of 2), cpu_shares 256 against egress's 1024, nice 10 in the image, and the
# agent's own CPU guard: the composite this worker exists for always wins. On a 2 vCPU
# worker the live model drops to base, which is what one core can keep up with.
CAPTIONS=0
if [[ -n "$CAPTIONS_IMAGE" && ${#CAPTIONS_SECRET} -ge 32 ]]; then
  CAPTIONS=1
  CAPTIONS_CPUS=$(( CPUS / 2 > 0 ? CPUS / 2 : 1 ))
  if (( CPUS >= 4 )); then CAPTIONS_MODEL=small; else CAPTIONS_MODEL=base; fi
  cat >>docker-compose.yml.new <<YAML
  captions:
    image: ${CAPTIONS_IMAGE}
    network_mode: host
    restart: unless-stopped
    cpus: ${CAPTIONS_CPUS}
    cpu_shares: 256
    mem_limit: 4g
    oom_score_adj: 800
    env_file: captions.env
    volumes:
      - captions_models:/models
      - captions_spool:/var/lib/captions
    stop_grace_period: 40s
volumes:
  captions_models:
  captions_spool:
YAML
  cat >captions.env.new <<ENV
LIVEKIT_URL=wss://${SFU_DOMAIN}
LIVEKIT_API_KEY=${LK_API_KEY}
LIVEKIT_API_SECRET=${LK_API_SECRET}
CAPTIONS_API_URL=${CAPTIONS_API_URL:-https://webinarliv.com}
CAPTIONS_SECRET=${CAPTIONS_SECRET}
CAPTIONS_CPUS=${CAPTIONS_CPUS}
CAPTIONS_MODEL=${CAPTIONS_MODEL}
CAPTIONS_MAX_ROOMS=1
ENV
  chmod 600 captions.env.new
else
  rm -f captions.env
fi

changed=0
files=(egress.yaml docker-compose.yml)
[[ "$CAPTIONS" == 1 ]] && files+=(captions.env)
for f in "${files[@]}"; do
  if ! cmp -s "$f.new" "$f"; then mv "$f.new" "$f"; changed=1; else rm -f "$f.new"; fi
done

# Pull only what is missing: a boot is about a minute from a webinar waiting on it.
docker image inspect livekit/egress:v1.15.0 >/dev/null 2>&1 && docker image inspect alpine/socat:1.8.0.3 >/dev/null 2>&1 \
  && { [[ "$CAPTIONS" != 1 ]] || docker image inspect "$CAPTIONS_IMAGE" >/dev/null 2>&1; } \
  || docker compose pull --quiet
if [[ "$changed" == 1 ]]; then
  docker compose up -d --force-recreate --remove-orphans
else
  docker compose up -d --remove-orphans
fi
echo "egress worker up: wss://${SFU_DOMAIN}, redis ${SFU_PRIVATE_IP}:6379, rtmp 127.0.0.1:1935 -> ${SFU_PRIVATE_IP}:1935"
