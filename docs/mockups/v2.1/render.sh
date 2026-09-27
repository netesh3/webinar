#!/bin/sh
# Render the v2.1 mocks to png/ with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p png
shot() { # name url height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=${W:-1280},"$3" --virtual-time-budget=1500 \
    --screenshot="png/$1.png" "file://$PWD/$2?clean" >/dev/null 2>&1
  echo "png/$1.png"
}
shot engagement       "engagement.html"       4760
shot webinar-messages "webinar-messages.html" 1060
