#!/usr/bin/env python3
"""Check the mockup set for the three mistakes that are easy to make here.

1. An icon name with no path in shell.js renders as an empty box — invisible in
   a screenshot review, obvious to a reader.
2. A link to a screen that does not exist, which is how a walkable demo quietly
   stops being walkable.
3. A class used in a screen that app.css never defines, usually a typo like
   `glyph-ok` for `glyph-wa`.

Exits non-zero on any finding so it can gate a commit.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCREENS = sorted((ROOT / "screens").glob("*.html"))
PAGES = SCREENS + [ROOT / "index.html"]

ICON_KEY = re.compile(r'^\s{4}"?([a-z0-9-]+)"?:\s*"', re.M)
ICON_USE = re.compile(r'data-icon="([^"]+)"')
ICON_CALL = re.compile(r'svg\("([a-z0-9-]+)"')
HREF = re.compile(r'href="([^"#][^"]*)"')
CLASS_USE = re.compile(r'class="([^"]+)"')
CLASS_DEF = re.compile(r"\.([a-zA-Z][\w-]*)")
STYLE = re.compile(r"<style>(.*?)</style>", re.S)

# Classes the shell adds at runtime, so they never appear in a screen's source.
RUNTIME = {
    "app", "sidebar", "brand", "brand-mark", "brand-name", "brand-sub",
    "workspace", "workspace-name", "nav", "nav-label", "nav-count", "health",
    "health-top", "health-meta", "account", "account-name", "account-role",
    "main", "topbar", "crumb", "sep", "topbar-search", "toasts", "toast",
    "jump", "jump-menu", "page-wide",
}


def fail(findings: list[str], label: str, items) -> None:
    for item in sorted(set(items)):
        findings.append(f"{label}: {item}")


def main() -> int:
    findings: list[str] = []

    shell = (ROOT / "assets" / "shell.js").read_text()
    css = (ROOT / "assets" / "app.css").read_text()
    known_icons = set(ICON_KEY.findall(shell))
    known_classes = set(CLASS_DEF.findall(css)) | RUNTIME

    if len(known_icons) < 40:
        findings.append(f"icon set looks truncated: parsed only {len(known_icons)}")

    # Icons referenced from the shell's own markup count as uses too.
    used_icons = set(ICON_CALL.findall(shell))
    undefined: set[str] = set()

    for page in PAGES:
        text = page.read_text()
        used_icons |= set(ICON_USE.findall(text))

        # The contact sheet carries a <style> block for its gallery, which no
        # screen needs and app.css therefore does not define.
        local = set()
        for style in STYLE.findall(text):
            local |= set(CLASS_DEF.findall(style))

        used = set()
        for chunk in CLASS_USE.findall(text):
            used |= set(chunk.split())
        undefined |= used - known_classes - local

        for href in HREF.findall(text):
            if href.startswith(("http://", "https://", "mailto:")):
                continue
            # ?step=4 and #dataset address a place within a page, not a file.
            path = re.split(r"[?#]", href)[0]
            target = (page.parent / path).resolve()
            if not target.exists():
                findings.append(f"broken link in {page.name}: {href}")

    fail(findings, "unknown icon", used_icons - known_icons)
    fail(findings, "undefined class", undefined)

    print(f"{len(PAGES)} pages · {len(known_icons)} icons defined · {len(used_icons)} used")
    if findings:
        print()
        for line in findings:
            print(f"  {line}")
        return 1
    print("no findings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
