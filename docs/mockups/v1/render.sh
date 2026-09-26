#!/bin/sh
# Render every v1 mock to png/ with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p png
shot() { # name url height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1440,"$3" --virtual-time-budget=1500 \
    --screenshot="png/$1.png" "file://$PWD/$2" >/dev/null 2>&1
  echo "png/$1.png"
}
shot host            "host.html"                       900
shot host-alerts     "host.html#alerts"                900
shot upcoming        "reminders.html"                  820
shot people          "webinar-people.html"             1000
shot send            "webinar-people.html#send"        900
shot host-people     "host-people.html"                980
shot host-messages   "host-messages.html"              900
shot messages-closed "host-messages.html#closed"       900
shot messages        "webinar-messages.html"           640
shot connect         "connect.html"                    820
shot connected       "connect.html#connected"          820
shot index           "index.html"                      1500
