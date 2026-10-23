#!/usr/bin/env bash
# The always-on ops droplet, ops-blr-1 (s-1vcpu-1gb, ~$6/month): runs the API's background pass
# once a minute and nothing heavy. See deploy/ops-box/README.md.
#
# The API is on Cloud Run, which gives it CPU only during requests, so something outside has to
# call POST /api/internal/tick every minute. That used to be the video server's cron; the video
# server is now created and deleted on demand (deploy/digitalocean/README.md) and the tick is
# also what creates it, so the caller has to be a box that is always there.
#
# Usage (as root on the droplet; the secret on stdin so it is never in argv or shell history):
#   printf '%s' "$TICK_SECRET" | TICK_URL=https://<api>/api/internal/tick bash install.sh
# Re-run to change the URL or the secret. With no secret on stdin the existing one is kept.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
CONF=/etc/webinarliv
HERE="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl cron ufw
systemctl enable --now cron

install -d -m 700 "$CONF"
if [[ -n "${TICK_URL:-}" ]]; then
  [[ "$TICK_URL" =~ ^https://[A-Za-z0-9.:/_-]+$ ]] || { echo "TICK_URL must be an https URL" >&2; exit 1; }
  umask 077
  echo "TICK_URL=${TICK_URL}" >"${CONF}/tick.env"
fi
if [[ ! -t 0 ]]; then
  secret="$(cat)"
  if [[ -n "$secret" ]]; then
    (( ${#secret} >= 32 )) || { echo "TICK_SECRET must be at least 32 characters" >&2; exit 1; }
    umask 077
    # A curl header file (-H @file): the secret never appears on a command line.
    printf 'X-Tick-Secret: %s\n' "$secret" >"${CONF}/tick.header"
  fi
fi
[[ -f "${CONF}/tick.env" && -f "${CONF}/tick.header" ]] || {
  echo "Needs TICK_URL (env) and the tick secret (stdin) the first time; see the usage above" >&2
  exit 1
}

install -m 700 "${HERE}/tick.sh" /usr/local/sbin/webinarliv-tick
echo "* * * * * root /usr/local/sbin/webinarliv-tick 2>&1 | logger -t webinarliv-tick" >/etc/cron.d/webinarliv-tick
chmod 644 /etc/cron.d/webinarliv-tick

# Nothing listens here but SSH.
ufw allow OpenSSH
ufw --force enable

/usr/local/sbin/webinarliv-tick && echo "Tick OK: every minute to $(cut -d= -f2- "${CONF}/tick.env")"
