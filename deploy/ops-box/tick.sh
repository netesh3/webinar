#!/usr/bin/env bash
# One background pass of the API (deploy/ops-box/README.md). Quiet unless it fails; cron sends
# the output to syslog (journalctl -t webinarliv-tick). "busy" (another pass running) is fine.
set -euo pipefail
CONF=/etc/webinarliv
url="$(grep -E '^TICK_URL=' "${CONF}/tick.env" | tail -1 | cut -d= -f2-)"
curl -fsS -m 55 -X POST -H "@${CONF}/tick.header" "$url" >/dev/null
