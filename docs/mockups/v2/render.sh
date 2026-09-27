#!/bin/sh
# Render every v2 mock to png/ with headless Chrome. png/now/ holds screenshots of
# the current app (demo coach), taken separately, for the before/after pairs.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p png
shot() { # name url height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1440,"$3" --virtual-time-budget=1500 \
    --screenshot="png/$1.png" "file://$PWD/$2?clean" >/dev/null 2>&1
  echo "png/$1.png"
}
shot webinar-messages "webinar-messages.html" 1320
shot inbox            "inbox.html"            860
shot send             "send.html"             940
shot people           "people.html"           900
shot home             "home.html"             760
shot automations      "automations.html"      820
shot attendee         "attendee.html"         820
shot index            "index.html"            1700
