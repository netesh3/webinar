#!/usr/bin/env python3
"""Flatten each Stitch export into readable text, so the rebuild can copy the
real labels and numbers instead of inventing them."""

import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
BLOCK = re.compile(
    r"</(?:div|section|header|footer|nav|aside|main|p|li|tr|h[1-6]|button|a|label|option|td|th|span)>",
    re.I,
)


def flatten(markup: str) -> str:
    markup = re.sub(r"<(script|style|svg|head)\b.*?</\1>", " ", markup, flags=re.S | re.I)
    markup = BLOCK.sub("\n", markup)
    markup = re.sub(r"<[^>]+>", " ", markup)
    text = html.unescape(markup)
    lines = []
    for line in text.split("\n"):
        line = " ".join(line.split())
        if not line or line == lines[-1:] and lines and line == lines[-1]:
            continue
        if lines and line == lines[-1]:
            continue
        lines.append(line)
    return "\n".join(lines)


def main() -> int:
    out = HERE / "digest"
    out.mkdir(exist_ok=True)
    for src in sorted(HERE.glob("*.html")):
        body = flatten(src.read_text(encoding="utf-8", errors="replace"))
        (out / f"{src.stem}.txt").write_text(body, encoding="utf-8")
        print(f"{src.stem:26} {len(body):6} chars")
    return 0


if __name__ == "__main__":
    sys.exit(main())
