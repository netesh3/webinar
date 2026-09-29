#!/bin/sh
# Render the simple-funnel mocks to png/ with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p png
shot() {
  # $1 name  $2 html  $3 height  $4 width (optional; other mocks stay at 1280)
  w=1280
  if [ -n "$4" ]; then w=$4; fi
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size="$w","$3" --virtual-time-budget=6000 \
    --screenshot="png/$1.png" "file://$PWD/$2?clean" >/dev/null 2>&1
  echo "png/$1.png"
}
shot index          index.html          760
shot home           home.html           640
shot webinar-before webinar-before.html 900
shot webinar-after  webinar-after.html  1160
shot audience       audience.html       1180
shot whatsapp       whatsapp.html       3010
shot whatsapp-templates-drawer whatsapp-templates-drawer.html 1522
shot whatsapp-templates-inline whatsapp-templates-inline.html 2928
shot create-tabs-webinar  create-tabs-webinar.html  2330
shot create-tabs-messages create-tabs-messages.html 1120
shot settings settings.html 1200
shot inbox inbox.html 1000 1440
shot perf-home perf-home.html 980
shot perf-completed-page2 perf-completed-page2.html 980
shot perf-drafts-empty perf-drafts-empty.html 560
shot perf-audience-page2 perf-audience-page2.html 720
shot perf-audience-empty perf-audience-empty.html 700
shot perf-inbox-page2 perf-inbox-page2.html 560
shot perf-registrants-page2 perf-registrants-page2.html 720
shot host-home host-home.html 760
shot host-home-empty host-home-empty.html 640
