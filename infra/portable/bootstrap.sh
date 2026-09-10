#!/usr/bin/env bash
#
# Bring the whole stack up on a fresh Linux box, on any cloud.
#
#   sudo DOMAIN=events.example.com ACME_EMAIL=you@example.com ./bootstrap.sh
#
# Written because the deployment was never actually AWS-specific — the compose file has
# no AWS in it at all — but the *process* was: images came from ECR, commands arrived by
# SSM Run Command, and the firewall was a security group. This script is the same five
# steps with none of that, so the target can be Oracle, Hetzner, Contabo, DigitalOcean,
# Vultr, a Raspberry Pi under a desk, or EC2 again.
#
# Safe to re-run. Secrets are generated once and then left alone — regenerating
# POSTGRES_PASSWORD on a second run would lock the API out of its own database, which is
# the sort of thing an "idempotent" script does if nobody thought about it.
#
# What it deliberately does NOT do: open the CLOUD's firewall. That lives outside the
# machine and every provider spells it differently, so it is a table in
# DEPLOY-ANYWHERE.md instead of a guess here. This script opens the HOST firewall and
# then tells you exactly which ports still need doing upstream.

set -euo pipefail

# ------------------------------------------------------------------ where things live

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${TARGET:-/opt/webcast}"
COMPOSE_SRC="$REPO_ROOT/infra/ec2/docker-compose.yml"   # historical name; nothing in it is EC2-specific
CADDY_SRC="$REPO_ROOT/infra/Caddyfile"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ! \033[0m%s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ \033[0m%s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m  ✓ \033[0m%s\n' "$*"; }

# ------------------------------------------------------------------ preconditions

[[ $EUID -eq 0 ]] || die "run as root: sudo -E $0"
[[ -n "${DOMAIN:-}" ]] || die "set DOMAIN, e.g. DOMAIN=events.example.com"
[[ -n "${ACME_EMAIL:-}" ]] || die "set ACME_EMAIL — Let's Encrypt needs an address for expiry warnings"

# The SFU is LiveKit Cloud, so its credentials are an INPUT to a deployment rather than
# something this script can generate. Required up front: the alternative is a stack that
# installs cleanly, starts, and refuses every join because there is nowhere to put a room.
#
# One project is enough to start. Add more later by editing $TARGET/.env — nothing here
# has to be re-run for that.
if [[ -z "${LIVEKIT_PROJECTS:-}" ]]; then
  die "set LIVEKIT_PROJECTS to the JSON array from your LiveKit Cloud project(s), e.g.
     LIVEKIT_PROJECTS='[{\"id\":\"cloud-1\",\"url\":\"wss://xxx.livekit.cloud\",\"key\":\"API…\",\"secret\":\"…\"}]'
   Get url/key/secret from Settings > API keys in the LiveKit Cloud dashboard."
fi

# A bare IP cannot hold a Let's Encrypt certificate, and getUserMedia needs a secure
# origin. Catching it here is kinder than catching it in Caddy's ACME logs 40 seconds in.
[[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && \
  die "DOMAIN must be a hostname, not an IP. See the 'Buy a domain first' note in DEPLOY-ANYWHERE.md"

for f in "$COMPOSE_SRC" "$CADDY_SRC"; do
  [[ -f "$f" ]] || die "missing $f — run this from a full checkout of the repo"
done

# ------------------------------------------------------------------ the public address

# Every cloud has a metadata service and every one of them is at a different path, so
# none of them are used. Asking the internet what address it sees works identically
# everywhere, and — importantly — it returns the address a BROWSER will use. On AWS,
# Oracle and GCP the interface only ever holds a private address, so reading it off the
# NIC would advertise something unroutable in every ICE candidate.
discover_ip() {
  local ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]')" || continue
    [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { printf '%s' "$ip"; return 0; }
  done
  return 1
}

say "Finding this machine's public address"
PUBLIC_IP="${PUBLIC_IP:-$(discover_ip || true)}"
[[ -n "$PUBLIC_IP" ]] || die "could not determine the public IP; pass it explicitly: PUBLIC_IP=203.0.113.10 $0"
ok "public IP: $PUBLIC_IP"

# The one check that catches the most common launch mistake before it costs an hour of
# ACME debugging: DNS that was never pointed here, or pointed at the old box.
resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')" || true
if [[ -z "$resolved" ]]; then
  warn "$DOMAIN does not resolve yet. Caddy will fail to get a certificate until it does."
elif [[ "$resolved" != "$PUBLIC_IP" ]]; then
  warn "$DOMAIN resolves to $resolved, not $PUBLIC_IP. Certificates will fail until DNS catches up."
else
  ok "$DOMAIN resolves here"
fi
# One record now. sfu.$DOMAIN used to be checked here as well, because the SFU's
# signalling endpoint was a subdomain this host terminated TLS for. LiveKit Cloud has its
# own hostname and its own certificate, so that record can be deleted.

# ------------------------------------------------------------------ ports

# Three TCP ports and no UDP at all.
#
# This used to read six port numbers out of livekit.yaml — an RTC range, an ICE-over-TCP
# port, a TURN port and a relay range — because the SFU ran on this host and media went
# straight to it. It does not any more: browsers connect to LiveKit Cloud directly, so
# nothing about media touches this machine and there is nothing to open for it.
#
# That deletes an entire class of deployment failure. The old comment here recorded that
# DEPLOY.md once documented 50000-50060 against a config of 50000-60060, and that the
# symptom was no error anywhere — media silently fell back to TCP. There is now no range
# to get wrong.
TCP_PORTS=(22 80 443)
UDP_RANGES=()

say "Ports this deployment needs"
printf '  tcp  %s\n' "${TCP_PORTS[*]}"
printf '  udp  (none — media goes to LiveKit Cloud, not to this host)\n'

# ------------------------------------------------------------------ docker

say "Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "already installed ($(docker --version))"
else
  # The convenience script covers Debian/Ubuntu/RHEL/Oracle Linux and picks the right
  # architecture, which matters because the cheapest capable box on this list — Oracle's
  # free tier — is arm64.
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "installed $(docker --version)"
fi
ok "architecture: $(uname -m)"

# No kernel tuning.
#
# This used to reserve the SFU's media range out of net.ipv4.ip_local_port_range, because
# the default 32768-60999 overlapped it and the kernel would occasionally hand one of
# those ports to its own outbound socket — an intermittent bind collision that looked
# like a network fault. With no SFU on this host there is no range to protect. An existing
# machine may still carry /etc/sysctl.d/99-livekit-ports.conf; it is harmless.

# ------------------------------------------------------------------ host firewall

# Two layers of firewall exist on every cloud and people routinely open one and not the
# other. This is the layer ON the machine. The provider's layer is in DEPLOY-ANYWHERE.md.
#
# Oracle is the reason this uses `-I` rather than `-A`: OCI's stock Ubuntu image ships an
# INPUT chain that REJECTs everything after SSH, saved in /etc/iptables/rules.v4. Rules
# appended after that REJECT are never reached, so a naive `-A` script "succeeds" and
# nothing gets through.
say "Host firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "^Status: active"; then
  for p in "${TCP_PORTS[@]}"; do ufw allow "$p/tcp" >/dev/null; done
  # `${arr[@]}` on an empty array is unbound under `set -u`, hence the length guard. The
  # array is empty in every current deployment; it stays here so a future service that
  # does need UDP has somewhere to say so.
  if (( ${#UDP_RANGES[@]} )); then
    for r in "${UDP_RANGES[@]}"; do ufw allow "${r/:/-}/udp" >/dev/null; done
  fi
  ok "ufw rules added"
elif command -v iptables >/dev/null 2>&1; then
  add() {  # idempotent insert at the top of INPUT
    iptables -C INPUT "$@" 2>/dev/null || iptables -I INPUT "$@"
  }
  for p in "${TCP_PORTS[@]}"; do add -p tcp --dport "$p" -j ACCEPT; done
  if (( ${#UDP_RANGES[@]} )); then
    for r in "${UDP_RANGES[@]}"; do add -p udp --dport "${r/:/:}" -j ACCEPT; done
  fi
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null
    ok "iptables rules inserted and persisted"
  elif [[ -d /etc/iptables ]]; then
    iptables-save >/etc/iptables/rules.v4
    ok "iptables rules inserted, saved to /etc/iptables/rules.v4"
  else
    warn "iptables rules inserted but NOT persisted — they will vanish on reboot."
    warn "install iptables-persistent (apt) or iptables-services (dnf)."
  fi
else
  warn "no ufw and no iptables found; assuming the host has no firewall of its own"
fi

# ------------------------------------------------------------------ stage the config

say "Staging $TARGET"
mkdir -p "$TARGET"
install -m 0644 "$COMPOSE_SRC" "$TARGET/docker-compose.yml"
install -m 0644 "$CADDY_SRC"   "$TARGET/Caddyfile"

# No livekit.yaml. It configured the SFU that used to run here — node_ip, the ICE port
# range, the embedded TURN server — and LiveKit Cloud is configured in its own dashboard.
# A machine upgraded in place may still have one at $TARGET/livekit.yaml; nothing reads it.

# ------------------------------------------------------------------ secrets

ENV_FILE="$TARGET/.env"
if [[ -f "$ENV_FILE" ]]; then
  ok ".env already exists — secrets left untouched"
  # DOMAIN can legitimately change (a migration, a new hostname). The database password
  # cannot, so only the safe keys are rewritten.
  #
  # LIVEKIT_PROJECTS is rewritten too, because unlike a database password it is not a
  # secret this machine owns — it is the operator's current answer to "which LiveKit
  # accounts are we using", and re-running bootstrap with a new one is how they change it.
  # Written with python rather than sed: the value is JSON full of / and " and & , all of
  # which sed would either treat as a delimiter or expand.
  DOMAIN="$DOMAIN" ACME_EMAIL="$ACME_EMAIL" LIVEKIT_PROJECTS="$LIVEKIT_PROJECTS" \
  python3 - "$ENV_FILE" <<'PYEOF'
import os, sys
path = sys.argv[1]
updates = {k: os.environ[k] for k in ("DOMAIN", "ACME_EMAIL", "LIVEKIT_PROJECTS")}
out, seen = [], set()
for line in open(path).read().splitlines():
    key = line.split("=", 1)[0] if "=" in line and not line.startswith("#") else None
    if key in updates:
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
open(path, "w").write("\n".join(out) + "\n")
PYEOF
  ok "DOMAIN, ACME_EMAIL and LIVEKIT_PROJECTS refreshed; generated secrets untouched"
else
  say "Generating secrets"
  umask 077
  cat >"$ENV_FILE" <<EOF
# Written by infra/portable/bootstrap.sh on $(date -u +%FT%TZ). Secrets are generated
# once; re-running bootstrap will not replace them.
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL

POSTGRES_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)

# Which LiveKit Cloud projects may take rooms, in priority order. New webinars go to the
# first entry without "disabled": true; every webinar remembers which project its room is
# on, so adding or retiring one never disturbs a session already scheduled or running.
#
# When this project's monthly allowance runs out: add "disabled": true to it, append the
# next project's credentials, and restart the api container. The ids are stored in the
# database, so add and disable freely but never RENAME one.
LIVEKIT_PROJECTS=$LIVEKIT_PROJECTS

# Built locally by bootstrap.sh. Point these at a registry instead if you would rather
# build elsewhere — the compose file does not care where an image came from.
API_IMAGE=webcast-api:local
WEB_IMAGE=webcast-web:local

APP_NAME=Webcast
# Left open so you can create the first host account, and closed immediately after.
SIGNUP_OPEN=true
MAX_ATTENDEES=500
JOIN_RATE_PER_MIN=1200
# Attendees behind one school or office NAT share a public IP, so a per-IP register
# limit tight enough to stop one abuser also stops a whole class signing up.
REGISTER_RATE_PER_MIN=300
EOF
  chmod 0600 "$ENV_FILE"
  ok ".env written (0600)"
fi

# ------------------------------------------------------------------ images

# Built on the box, which is the single biggest thing that made this portable. ECR was
# the only genuinely AWS-shaped dependency in the deployment; building here removes both
# it and the cross-architecture problem, because the build is native to whatever this is.
say "Building images (this is the slow part — a few minutes on first run)"
docker build -t webcast-api:local "$REPO_ROOT/api"
docker build -t webcast-web:local "$REPO_ROOT/web"
ok "webcast-api:local and webcast-web:local built for $(uname -m)"

# ------------------------------------------------------------------ up

say "Starting the stack"
cd "$TARGET"
docker compose up -d
docker compose ps

# ------------------------------------------------------------------ what is left

cat <<EOF

$(printf '\033[1;32m%s\033[0m' "Stack is up.")

Two things this script could not do for you, both outside the machine:

  1. THE CLOUD FIREWALL. Open these in your provider's console — security group,
     network security list, cloud firewall, whatever they call it:

       tcp  ${TCP_PORTS[*]}
       udp  (none)

     Three ports and no UDP. If you are upgrading a machine that used to run the SFU
     here, you can now CLOSE 7881/tcp, 3478/udp and 50000-60060/udp in both the cloud
     firewall and the host one — nothing on this box listens on them any more.

  2. DNS. One record, pointing at ${PUBLIC_IP}:

       A   ${DOMAIN}   -> ${PUBLIC_IP}

     sfu.${DOMAIN} is no longer used and can be deleted.

Then verify, in this order — each one rules out a different layer:

  docker compose -f ${TARGET}/docker-compose.yml logs -f caddy   # certificate issued?
  curl -sS https://${DOMAIN}/api/config                          # app reachable?
  node infra/portable/preflight.mjs ${DOMAIN}                    # run from a LAPTOP
  node e2e/probe-room.mjs https://${DOMAIN}                      # does media actually flow?

(/api/config, not /healthz — the API's own health routes live at its root and Caddy only
forwards /api/*, so they are reachable from inside the compose network and nowhere else.)

That last one is the only check that matters. It reports the selected ICE candidate
pair: you want a line containing 'udp' and 'SELECTED'. If it says tcp, the UDP range
is closed somewhere above and everything will work slowly and drop when idle.

Finally, once your host account exists:

  sed -i 's/^SIGNUP_OPEN=true/SIGNUP_OPEN=false/' ${TARGET}/.env
  docker compose -f ${TARGET}/docker-compose.yml up -d api

EOF
