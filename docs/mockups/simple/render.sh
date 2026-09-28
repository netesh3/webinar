#!/bin/sh
# Render the simple-funnel mocks to png/ with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p png
shot() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1280,"$3" --virtual-time-budget=1500 \
    --screenshot="png/$1.png" "file://$PWD/$2?clean" >/dev/null 2>&1
  echo "png/$1.png"
}
shot index          index.html          760
shot home           home.html           640
shot create         create.html         900
shot webinar-before webinar-before.html 900
shot webinar-after  webinar-after.html  960
shot audience       audience.html       1180
shot whatsapp       whatsapp.html       1900
