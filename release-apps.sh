#!/usr/bin/env bash
#
# Pull origin/main, build signed Mac / iOS / Android, publish.
# Same as ./start.sh: run this from the repo root.
#
#   ./release-apps.sh
#   ./release-apps.sh --dry-run
#   ./release-apps.sh --help
#
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/release-apps.sh" "$@"
