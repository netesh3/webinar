#!/usr/bin/env python3
"""Generate docs/webcast-architecture.excalidraw.

Written as a generator rather than hand-authored JSON for one reason: the diagram has to stay
true to the deployment, and the deployment changes. Editing a script is reviewable; editing
four thousand lines of coordinates is not. Re-run it after an infrastructure change.

Open the output at excalidraw.com (File -> Open) or with the VS Code Excalidraw extension.

Every number and setting in here was measured or read off the running system during the
session that produced it; see ARCHITECTURE.md for the evidence behind each one.
"""
import json
import random

random.seed(7)  # stable ids and seeds, so re-running gives a reviewable diff

elements = []

# Excalidraw's palette, so the file looks native rather than generated.
INK = "#1e1e1e"
BLUE, BLUE_BG = "#1971c2", "#a5d8ff"
GREEN, GREEN_BG = "#2f9e44", "#b2f2bb"
RED, RED_BG = "#e03131", "#ffc9c9"
ORANGE, ORANGE_BG = "#f08c00", "#ffec99"
GREY, GREY_BG = "#495057", "#e9ecef"
VIOLET, VIOLET_BG = "#6741d9", "#d0bfff"

HAND, CODE, SANS = 1, 3, 2  # fontFamily ids


def _base(kind, x, y, w, h, **kw):
    el = {
        "id": f"{kind}-{len(elements)}-{random.randint(1000, 9999)}",
        "type": kind,
        "x": x, "y": y, "width": w, "height": h,
        "angle": 0,
        "strokeColor": INK,
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "seed": random.randint(1, 2**31),
        "version": 1,
        "versionNonce": random.randint(1, 2**31),
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
    }
    el.update(kw)
    elements.append(el)
    return el


def box(x, y, w, h, stroke=INK, bg="transparent", dashed=False, rounded=True, width=2):
    return _base(
        "rectangle", x, y, w, h,
        strokeColor=stroke, backgroundColor=bg, strokeWidth=width,
        strokeStyle="dashed" if dashed else "solid",
        roundness={"type": 3} if rounded else None,
    )


def text(x, y, s, size=16, colour=INK, font=SANS, align="left"):
    lines = s.split("\n")
    w = max((len(l) for l in lines), default=1) * size * 0.58
    h = len(lines) * size * 1.25
    return _base(
        "text", x, y, w, h,
        strokeColor=colour, fontSize=size, fontFamily=font,
        text=s, originalText=s,
        textAlign=align, verticalAlign="top",
        containerId=None, lineHeight=1.25, baseline=int(size * 0.9),
    )


def arrow(x1, y1, x2, y2, colour=INK, dashed=False, label=None, label_dx=8, label_dy=-22,
          label_size=13, width=2):
    _base(
        "arrow", x1, y1, abs(x2 - x1), abs(y2 - y1),
        strokeColor=colour, strokeWidth=width,
        strokeStyle="dashed" if dashed else "solid",
        points=[[0, 0], [x2 - x1, y2 - y1]],
        lastCommittedPoint=None,
        startBinding=None, endBinding=None,
        startArrowhead=None, endArrowhead="arrow",
        roundness={"type": 2},
    )
    if label:
        text((x1 + x2) / 2 + label_dx, (y1 + y2) / 2 + label_dy, label,
             size=label_size, colour=colour, font=CODE)


def band(y, title, subtitle):
    text(60, y, title, size=30, font=HAND)
    text(60, y + 40, subtitle, size=15, colour=GREY)


# ════════════════════════════════════════════════════════════ 1. DEPLOYMENT
band(40, "1 · Deployment topology", "Everything on one machine. Measured 9 Sep 2026.")

# ---- clients
box(60, 150, 250, 110, stroke=BLUE, bg=BLUE_BG)
text(80, 168, "Audience browser", size=17, font=HAND)
text(80, 196, "subscribe only\nno camera, no mic", size=13, font=CODE, colour=GREY)

box(60, 300, 250, 110, stroke=VIOLET, bg=VIOLET_BG)
text(80, 318, "Host / panelist", size=17, font=HAND)
text(80, 346, "publishes camera,\nmic, screen", size=13, font=CODE, colour=GREY)

text(60, 440, "Both in India.\nRTT to the SFU: 264-285 ms.\nThat is distance, not\ncongestion - and it is the\nlargest latency term left.",
     size=13, colour=RED, font=CODE)

# ---- the instance
box(470, 120, 1010, 620, stroke=GREY, bg="transparent", dashed=True, width=3)
text(495, 138, "EC2  t3.medium  ·  2 vCPU / 4 GB  ·  us-east-1b", size=19, font=HAND)
text(495, 168, "3.82.201.244   ← EPHEMERAL IP: a stop loses it, and the URL with it",
     size=13, colour=RED, font=CODE)

# caddy
box(500, 210, 230, 110, stroke=GREEN, bg=GREEN_BG)
text(518, 228, "caddy", size=18, font=HAND)
text(518, 254, ":80  :443\nauto TLS\none origin", size=13, font=CODE, colour=GREY)

# web + api
box(800, 205, 200, 80, stroke=BLUE, bg=BLUE_BG)
text(818, 220, "web", size=17, font=HAND)
text(818, 244, "Next.js :3000", size=12, font=CODE, colour=GREY)

box(800, 305, 200, 80, stroke=BLUE, bg=BLUE_BG)
text(818, 320, "api", size=17, font=HAND)
text(818, 344, "Go :8080", size=12, font=CODE, colour=GREY)

box(1070, 305, 200, 80, stroke=GREY, bg=GREY_BG)
text(1088, 320, "postgres 16", size=16, font=HAND)
text(1088, 344, "timestamptz = UTC", size=11, font=CODE, colour=GREY)

# livekit
box(500, 420, 470, 170, stroke=ORANGE, bg=ORANGE_BG)
text(520, 438, "livekit-server  v1.9.12", size=18, font=HAND)
text(520, 468, "network_mode: host   ← binds host ports directly,\n"
               "                     so the firewall is the only gate\n"
               "use_ice_lite: FALSE  ← the fix that moved media to UDP\n"
               "turn relay: 30000-31000/udp",
     size=12, font=CODE, colour=GREY)

# volumes
box(1070, 420, 200, 170, stroke=GREY, bg=GREY_BG)
text(1088, 438, "volumes", size=16, font=HAND)
text(1088, 466, "pgdata\nrecordings\ncaddy_data\ncaddy_config", size=12, font=CODE, colour=GREY)
text(1088, 550, "no backups", size=12, font=CODE, colour=RED)

# routing labels
arrow(315, 205, 495, 240, colour=BLUE, label="https :443", label_dy=-26)
arrow(315, 355, 495, 290, colour=VIOLET, label="https :443", label_dy=4)
arrow(735, 250, 795, 240, colour=GREEN, label="/*", label_dx=-6, label_dy=-24)
arrow(735, 280, 795, 330, colour=GREEN, label="/api/*", label_dx=-14, label_dy=2)
arrow(900, 290, 900, 300, colour=BLUE)
arrow(1005, 345, 1065, 345, colour=BLUE, label="sql", label_dy=-22)
arrow(640, 325, 620, 415, colour=GREEN, label="wss  sfu.DOMAIN", label_dx=-100, label_dy=-4)

# the media path, which is the point
arrow(310, 400, 495, 480, colour=RED, dashed=True, width=3)
text(150, 560, "MEDIA NEVER TOUCHES CADDY\n"
               "a reverse proxy cannot carry RTP\n\n"
               "50000-60060/udp   media  ← first choice\n"
               "3478/udp          TURN\n"
               "30000-31000/udp   TURN relay\n"
               "7881/tcp          fallback only, slow",
     size=13, colour=RED, font=CODE)

# supporting services
box(500, 640, 470, 80, stroke=GREY, bg="transparent", dashed=True)
text(520, 656, "deploys:  ECR image pins in .env  →  SSM Run Command  →  docker compose up -d",
     size=12, font=CODE, colour=GREY)
text(520, 686, "no CI, no registry promotion, tags are timestamps", size=12, font=CODE, colour=ORANGE)

# ════════════════════════════════════════════════════════════ 2. MEDIA MODEL
band(820, "2 · Publisher / subscriber", "One publisher, many subscribers, three simulcast layers.")

box(60, 930, 230, 150, stroke=VIOLET, bg=VIOLET_BG)
text(80, 948, "Host publishes", size=17, font=HAND)
text(80, 976, "ONE encode,\nthree layers:\n\nh180  ~150 kbps\nh360  ~800 kbps\nh720  ~1.7 Mbps",
     size=12, font=CODE, colour=GREY)

box(430, 930, 280, 150, stroke=ORANGE, bg=ORANGE_BG)
text(450, 948, "SFU forwards", size=17, font=HAND)
text(450, 976, "it does NOT transcode.\nPer subscriber it picks\nONE layer and copies it.\n\n"
               "dynacast: pause unused\nadaptiveStream: by tile size",
     size=12, font=CODE, colour=GREY)

for i, (yy, who, what) in enumerate([
    (900, "attendee on a laptop", "h720  ~1.7 Mbps"),
    (975, "attendee in a grid", "h360  ~800 kbps"),
    (1050, "attendee on a phone", "h180  ~150 kbps"),
]):
    box(850, yy, 330, 60, stroke=BLUE, bg=BLUE_BG)
    text(868, yy + 10, who, size=14, font=HAND)
    text(868, yy + 32, what, size=12, font=CODE, colour=GREY)
    arrow(715, 1000, 845, yy + 30, colour=ORANGE)

arrow(295, 1000, 425, 1000, colour=VIOLET, label="RTP up", label_dy=-24)

text(60, 1110, "Cost is EGRESS, and it is linear in the audience:  500 attendees x ~800 kbps = ~430 Mbps.\n"
               "Attendees publish nothing, so inbound is only the presenters.",
     size=14, colour=GREY, font=CODE)

text(60, 1170, "Automatic quality: judge() in lib/network.ts samples loss, RTT and available bandwidth every 2 s\n"
               "and steps the publisher full -> reduced -> minimal. RTT is judged as EXCESS OVER THIS ROUTE'S FLOOR,\n"
               "never absolutely - an absolute 300 ms threshold made a 280 ms route degrade and never recover.",
     size=13, colour=GREEN, font=CODE)

# ════════════════════════════════════════════════════════════ 3. JOURNEYS
band(1290, "3 · Three separate experiences", "Separated by route and enforced three times, not by hiding buttons.")

lanes = [
    (1400, VIOLET, VIOLET_BG, "HOST", [
        "/host/login", "/host  dashboard", "/host/new  schedule",
        "/host/<slug>  manage", "/host/<slug>/room  stage",
    ]),
    (1560, BLUE, BLUE_BG, "PARTICIPANT", [
        "/webinars/<slug>", "register  (name, email, phone)",
        "confirmation + join gate", "/webinars/<slug>/room", "subscribe only",
    ]),
    (1720, GREEN, GREEN_BG, "PANELIST", [
        "panelist link", "/host/<slug>/room", "publishes, cannot manage",
    ]),
]
for y, stroke, bg, name, steps in lanes:
    box(60, y, 150, 60, stroke=stroke, bg=bg)
    text(78, y + 18, name, size=16, font=HAND)
    x = 240
    for i, s in enumerate(steps):
        w = max(150, len(s) * 8 + 30)
        box(x, y, w, 60, stroke=stroke, bg="transparent")
        text(x + 14, y + 22, s, size=12, font=CODE)
        if i:
            arrow(x - 28, y + 30, x - 4, y + 30, colour=stroke, width=1)
        x += w + 28

text(60, 1820, "Enforced in three places, and only the last one is authoritative:", size=15, font=HAND)
text(60, 1852,
     "1  lib/access.ts + middleware.ts   answers before a page renders, so nothing host-shaped is ever sent\n"
     "2  the API                          requireHost / requireOwnership on every host route\n"
     "3  the LiveKit token                canPublish is decided server-side; a client cannot ask for a role",
     size=13, font=CODE, colour=GREY)

text(60, 1950, "Gates on the participant path:", size=15, font=HAND)
text(60, 1982,
     "doors open 15 min before startsAt   ·   409 too_early before that, with the time in the webinar's own zone\n"
     "passcode checked at REGISTRATION, because that is the only place a join key is minted\n"
     "attendee chat / polls / hands go through the API, not the data channel - their token cannot publish data",
     size=13, font=CODE, colour=GREY)

# ════════════════════════════════════════════════════════════ 4. WHAT IS NOT READY
band(2080, "4 · Known limits", "Honest gaps, as of this diagram.")
box(60, 2180, 1420, 230, stroke=RED, bg=RED_BG, dashed=True)
text(85, 2200,
     "EPHEMERAL IP          no Elastic IP. Any stop changes 3.82.201.244 and breaks every link already sent.\n"
     "BURSTABLE INSTANCE    t3.medium: 2 vCPU, credit-based network. 500 attendees needs ~430-900 Mbps sustained.\n"
     "NO LOAD TEST          the largest verified figure is 10 attendees, and that was the test rig folding,\n"
     "                      not the server: it sat at 0.05% CPU. The real ceiling is unmeasured.\n"
     "SINGLE POINT          one instance, one Postgres, no replica, no snapshots.\n"
     "NO TURN OFFERED       clients gather no relay candidate; a UDP-blocked network still falls back to TCP.\n"
     "REGION                us-east-1 serving India. Only moving the SFU closer fixes the 280 ms.",
     size=13, font=CODE)

doc = {
    "type": "excalidraw",
    "version": 2,
    "source": "webcast docs/make-diagram.py",
    "elements": elements,
    "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
    "files": {},
}

out = "docs/webcast-architecture.excalidraw"
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
print(f"wrote {out}: {len(elements)} elements")
