#!/usr/bin/env bash
# Launches three isolated Chrome instances with synthetic camera/mic, so the
# WebRTC path can be driven without three physical webcams.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

pkill -f 'remote-debugging-port=92' 2>/dev/null || true
sleep 1
rm -rf /tmp/prof-host /tmp/prof-a1 /tmp/prof-a2

launch() {
  # --auto-select-desktop-capture-source answers the screen-picker dialog without
  # a human, which is what lets the test drive a real screen share. Note that
  # navigator.mediaDevices only exists on a secure origin, so getDisplayMedia is
  # unavailable on about:blank and only works once the page is on the app.
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --remote-debugging-port="$2" --user-data-dir="$1" --no-first-run \
    --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
    --auto-select-desktop-capture-source="Entire screen" \
    --autoplay-policy=no-user-gesture-required \
    about:blank >"/tmp/chrome-$3.log" 2>&1 &
  echo "  launched $3 on :$2"
}

launch /tmp/prof-host 9222 host
launch /tmp/prof-a1   9223 attendee1
launch /tmp/prof-a2   9224 attendee2
sleep 5

for p in 9222 9223 9224; do
  curl -sf -o /dev/null "http://127.0.0.1:$p/json/version" && echo "  :$p ready"
done
