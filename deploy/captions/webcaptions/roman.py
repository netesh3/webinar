"""Retired: captions are English only, so there is no Devanagari to transliterate.

The after-session finalizer still calls apply_script(text, script); it is a pass-through
until that call is removed, after which this module can go too.
"""

from __future__ import annotations


def apply_script(text: str, script: str = "native") -> str:
    return text
