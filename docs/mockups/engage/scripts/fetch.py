#!/usr/bin/env python3
"""Download the Engage mockup screens from Stitch: the HTML for each, and a manifest.

    STITCH_API_KEY=... python3 scripts/fetch.py

The key is read from the environment on purpose — it is an account credential and has no
business in a tracked file. Get one from the Stitch API Keys page.

Run fetch.py before wire.py — the exports arrive with dead links and wire.py is what points
them at each other. render.mjs can run at any point after that: it removes the switcher
itself before measuring a page, so it no longer has to go first.
"""
import glob, json, os, subprocess, sys, urllib.request

ENDPOINT = "https://stitch.googleapis.com/mcp"
PROJECT = "15634464602460218258"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

# Screen id -> the file name it lands under. The order is the order a host would meet
# these screens, which is also the order the contact sheet and the switcher use.
WANT = [
    ("c400350eb3d34671b4cbcf752ecc93b5", "dashboard"),
    ("bf6fb95f044f40c39ecea0c464ae4764", "contacts"),
    ("dadc6d6d3865474f8535f37f71b6f491", "journeys"),
    ("e25cea4eca3b4db4a7fd33fd9d11fbb7", "campaigns"),
    ("4eaad0a1e5684ff0b7431d98d0e71260", "templates"),
    ("e1c1c74ad49342c9879966a2927d520a", "analytics"),
    ("103af104fee941159670bb06927e703b", "integrations"),
    ("43c2c6c61b3a4f6aa99417a10cbc5aa6", "settings"),
    ("2a35ba581efc4e369e3d9f1c8ec34805", "journey-builder"),
    ("2b4f6065988c4b5a8cd22bf3f3754855", "journey-builder-spacious"),
    ("f09bf71f1678456181040da77eb38269", "step-branch-rules"),
    ("e3ed98420c2e4e189093be00f151b88d", "modal-create-journey"),
    ("18bda2c9bbac417eaaa706036fdd6236", "modal-create-campaign"),
    ("beeb12f4d6d24947b335a1a591b74e16", "modal-import-contacts"),
    ("7ab4567066354bd8a0d66766cc531da2", "settings-channels"),
    # Screens in the project that were not on the list of fifteen, but that buttons on the
    # fifteen point at ("View Activity Log", "View Broadcast Logs", "Manage in WhatsApp
    # Hub") or that answer an obvious question ("where is the flow builder?"). Without them
    # those buttons have nowhere to go. They belong to two other app shells — see the
    # SHELLS map in wire.py.
    ("9d5a6c3d31494ccd8ce4b32fb7a7c0e0", "whatsapp-hub"),
    ("f314e5f2172947a09d54fbf5d3f7e2a5", "flow-builder"),
    ("53d46fc4f7994bc5a3863d27e7069f25", "exec-logs"),
    ("1df87d735bba4a4c882145ab11763467", "attendance"),
    ("de4e3c581b124d39a549a6c7199a7a80", "database-webhooks"),
]


def call(tool: str, args: dict) -> dict:
    """One MCP tools/call. The server is stateless streamable HTTP, so a lone POST is a
    complete conversation — but it may answer as SSE, hence the data: unwrapping."""
    key = os.environ.get("STITCH_API_KEY")
    if not key:
        sys.exit("set STITCH_API_KEY (Stitch API Keys page)")
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": tool, "arguments": args},
            }
        ).encode(),
        headers={
            "X-Goog-Api-Key": key,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    raw = urllib.request.urlopen(req, timeout=600).read().decode()
    frames = [l[6:] for l in raw.splitlines() if l.startswith("data: ")]
    envelope = json.loads(frames[-1] if frames else raw)
    return json.loads(envelope["result"]["content"][0]["text"])


screens = {s["name"].split("/")[-1]: s for s in call("list_screens", {"projectId": PROJECT})["screens"]}

os.makedirs(f"{OUT}/screens", exist_ok=True)
manifest = []
for sid, slug in WANT:
    s = screens.get(sid)
    if not s:
        print(f"MISSING {sid} {slug} — deleted upstream?", file=sys.stderr)
        continue
    dest = f"{OUT}/screens/{slug}.html"
    subprocess.run(["curl", "-sSL", "-o", dest, s["htmlCode"]["downloadUrl"]], check=True)
    manifest.append(
        {
            "id": sid,
            "slug": slug,
            "title": s["title"],
            "width": int(s["width"]),
            "height": int(s["height"]),
            "html_bytes": os.path.getsize(dest),
        }
    )
    print(f'{slug:28} {manifest[-1]["html_bytes"]:>8}B  {s["title"]}')

json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=2)

keep = {slug for _, slug in WANT}
for p in glob.glob(f"{OUT}/screens/*.html") + glob.glob(f"{OUT}/shots/*.png"):
    if os.path.basename(p).rsplit(".", 1)[0] not in keep:
        print(f"STALE, delete it: {p}", file=sys.stderr)

print(f"\n{len(manifest)} screens")
