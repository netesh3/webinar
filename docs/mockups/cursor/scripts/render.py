#!/usr/bin/env python3
"""Render every screen with headless Chrome into thumbs/, for the contact sheet.

Thumbnails are taken at a fixed viewport rather than full page height: a contact
sheet wants one aspect ratio, and the top of each screen is the part worth
recognising. Full-height captures are what shots/ holds, from Stitch.

The broadcast wizard is five layers deep behind a Next button, so its steps are
rendered separately through ?step=N into flow/ — headless Chrome cannot click,
and a mockup nobody can see past step one is the thing this set exists to fix.

Unlike the Stitch exports these screens need no network, so there is no
virtual-time budget to wait out — the run is a couple of seconds.
"""

import sys
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1440, 1000

SCREENS = [
    "dashboard",
    "inbox",
    "inbox-session-closed",
    "contacts",
    "journeys",
    "campaigns",
    "templates",
    "analytics",
    "integrations",
    "settings",
    "journey-builder",
    "journey-builder-spacious",
    "step-branch-rules",
    "modal-create-journey",
    "modal-create-campaign",
    "modal-import-contacts",
    "settings-channels",
]

# (destination folder, file name, page query) for the wizard's own layers.
WIZARD = [
    ("flow", f"broadcast-{n}", f"modal-create-campaign.html?step={n}")
    for n in range(1, 6)
]

JOBS = [("thumbs", slug, f"{slug}.html") for slug in SCREENS] + WIZARD


def shoot(job: tuple[str, str, str]) -> tuple[str, int]:
    folder, name, page = job
    dest = ROOT / folder / f"{name}.png"
    subprocess.run(
        [
            CHROME,
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--hide-scrollbars",
            "--force-color-profile=srgb",
            f"--window-size={WIDTH},{HEIGHT}",
            f"--screenshot={dest}",
            f"file://{ROOT}/screens/{page}",
        ],
        capture_output=True,
    )
    return f"{folder}/{name}", dest.stat().st_size if dest.exists() else 0


def main() -> int:
    for folder in {job[0] for job in JOBS}:
        (ROOT / folder).mkdir(exist_ok=True)

    missing = [s for s in SCREENS if not (ROOT / "screens" / f"{s}.html").exists()]
    if missing:
        print("missing screens:", ", ".join(missing), file=sys.stderr)
        return 1

    empty = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for name, size in pool.map(shoot, JOBS):
            flag = ""
            if size < 20_000:
                flag = "  ← suspiciously empty"
                empty += 1
            print(f"{name:34} {size:>8}B{flag}")
    return 1 if empty else 0


if __name__ == "__main__":
    raise SystemExit(main())
