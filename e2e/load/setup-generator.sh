#!/usr/bin/env bash
# Prepare a fresh Ubuntu 24.04 droplet as a load generator (docs/LOAD-TESTING.md).
#
# Use it as the droplet's user data (cloud-init runs it as root on first boot):
#
#   doctl compute droplet create loadgen-1 --region blr1 --size c-8 --image ubuntu-24-04-x64 \
#     --ssh-keys <id> --tag-names loadgen --user-data-file e2e/load/setup-generator.sh --wait
#
# or run it by hand on the droplet: `curl -fsSL <raw url> | sudo bash`. Safe to run again.
#
# It installs Node 22 and Chromium-compatible Google Chrome (for presenter.mjs and the WebRTC
# attendees), fetches e2e/ from the repo (LOADGEN_REPO / LOADGEN_REF), raises the open-file and
# process limits, widens the ephemeral port range and tunes TCP for many short and long-lived
# connections. Nothing secret is needed or written: the admin credentials are given on the
# command line of run.mjs at run time (environment variables), not stored here.
set -euo pipefail

REPO="${LOADGEN_REPO:-netesh3/webinar}"
REF="${LOADGEN_REF:-main}"
DIR="${LOADGEN_DIR:-/opt/loadgen}"
log() { echo "$(date -u +%FT%TZ) loadgen-setup: $*"; }
exec > >(tee -a /var/log/loadgen-setup.log) 2>&1

export DEBIAN_FRONTEND=noninteractive

# 1. Packages: Node 22 (NodeSource), Chrome stable (fake camera/mic flags need a real Chrome),
#    ffmpeg (makes the presenter's looping test video), and tools for watching the run.
log "installing packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git jq htop iftop sysstat ffmpeg fonts-dejavu-core
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v google-chrome >/dev/null; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    >/etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
fi

# 2. Limits: every viewer holds an events stream plus playlist/segment sockets; every Chrome tab
#    is a process tree.
log "raising limits"
cat >/etc/security/limits.d/90-loadgen.conf <<'EOF'
*    soft nofile 1048576
*    hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
*    soft nproc  65535
*    hard nproc  65535
EOF
mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nDefaultLimitNOFILE=1048576\n' >/etc/systemd/system.conf.d/90-loadgen.conf

# 3. Network: many outbound connections to one CDN/origin address, so widen the ephemeral range,
#    reuse TIME_WAIT sockets and give the accept/backlog queues room.
log "tuning sysctl"
cat >/etc/sysctl.d/90-loadgen.conf <<'EOF'
fs.file-max = 2097152
fs.nr_open = 1048576
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.ipv4.tcp_rmem = 4096 87380 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
EOF
modprobe tcp_bbr 2>/dev/null || true
sysctl --system >/dev/null

# 4. The kit: e2e/ from the repo (the load tools import the existing probes and helpers).
log "fetching e2e/ from ${REPO}@${REF}"
tmp="$(mktemp -d)"
curl -fsSL --retry 5 -m 180 "https://codeload.github.com/${REPO}/tar.gz/${REF}" |
  tar -xz -C "$tmp" --strip-components=1 --wildcards '*/e2e/*' '*/docs/LOAD-TESTING.md'
mkdir -p "$DIR"
rm -rf "${DIR}/e2e"
cp -a "${tmp}/e2e" "${DIR}/e2e"
cp -a "${tmp}/docs/LOAD-TESTING.md" "${DIR}/LOAD-TESTING.md" 2>/dev/null || true
rm -rf "$tmp"

# 5. Sanity: Node parses the kit and Chrome starts headless.
cd "${DIR}/e2e/load"
for f in *.mjs lib/*.mjs; do node --check "$f"; done
google-chrome --headless=new --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null 2>&1 &&
  log "chrome ok: $(google-chrome --version)"
log "ready: cd ${DIR}/e2e/load && ulimit -n 1048576 && node run.mjs --help"
