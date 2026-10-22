"""The speakers' audio, kept on local disk for the after-session transcript.

One directory per room job:

    <spool>/<room>__<job>/manifest.json         room, created, done, attempts
    <spool>/<room>__<job>/<speaker>.pcm         16 kHz mono int16, voiced utterances only
    <spool>/<room>__<job>/<speaker>.jsonl       one line per utterance:
                                                {offset, samples, start (Unix ms), identity, name}

Only what the segmenter called speech is written, so a two-hour session where two people
talk for forty minutes is ~150 MB, not ~460. The finalizer deletes the directory once the
transcript is posted (or given up on).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2


def safe_name(identity: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]", "_", identity)[:80] or "speaker"
    return cleaned


@dataclass
class IndexEntry:
    offset: int  # samples into the speaker's .pcm
    samples: int
    start_ms: int
    identity: str
    name: str


class RoomSpool:
    def __init__(self, root: str | os.PathLike[str], room: str, job_id: str, max_bytes: int) -> None:
        self.dir = Path(root) / f"{safe_name(room)}__{safe_name(job_id)}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.room = room
        self._max_bytes = max_bytes
        self._written = 0
        self._offsets: dict[str, int] = {}
        self._full_logged = False
        write_manifest(self.dir, {"room": room, "job": job_id, "created": time.time(), "done": False, "attempts": 0})

    def write(self, identity: str, name: str, audio: np.ndarray, start_ms: int) -> bool:
        """Append one utterance. False (and nothing written) once the size cap is reached."""
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        if self._written + len(pcm) > self._max_bytes:
            return False
        base = safe_name(identity)
        offset = self._offsets.get(base)
        if offset is None:
            pcm_path = self.dir / f"{base}.pcm"
            offset = pcm_path.stat().st_size // BYTES_PER_SAMPLE if pcm_path.exists() else 0
        with open(self.dir / f"{base}.pcm", "ab") as f:
            f.write(pcm)
        samples = len(pcm) // BYTES_PER_SAMPLE
        with open(self.dir / f"{base}.jsonl", "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {"offset": offset, "samples": samples, "start": int(start_ms), "identity": identity, "name": name},
                    ensure_ascii=False,
                )
                + "\n"
            )
        self._offsets[base] = offset + samples
        self._written += len(pcm)
        return True

    def mark_done(self) -> None:
        m = read_manifest(self.dir) or {"room": self.room}
        m["done"] = True
        m["ended"] = time.time()
        write_manifest(self.dir, m)


def write_manifest(d: Path, data: dict) -> None:
    tmp = d / "manifest.json.tmp"
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, d / "manifest.json")


def read_manifest(d: Path) -> dict | None:
    try:
        return json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def read_index(d: Path) -> dict[str, list[IndexEntry]]:
    """Every speaker's utterances, keyed by the .pcm file stem."""
    out: dict[str, list[IndexEntry]] = {}
    for idx in sorted(d.glob("*.jsonl")):
        entries: list[IndexEntry] = []
        for line in idx.read_text(encoding="utf-8").splitlines():
            try:
                j = json.loads(line)
                entries.append(
                    IndexEntry(
                        offset=int(j["offset"]), samples=int(j["samples"]), start_ms=int(j["start"]),
                        identity=str(j["identity"]), name=str(j.get("name", "")),
                    )
                )
            except (ValueError, KeyError, TypeError):
                continue  # a line cut short by a crash
        if entries:
            out[idx.stem] = entries
    return out


def read_pcm(d: Path, stem: str, offset: int, samples: int) -> np.ndarray:
    with open(d / f"{stem}.pcm", "rb") as f:
        f.seek(offset * BYTES_PER_SAMPLE)
        raw = f.read(samples * BYTES_PER_SAMPLE)
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def remove(d: Path) -> None:
    shutil.rmtree(d, ignore_errors=True)


def close_orphans(root: str | os.PathLike[str]) -> int:
    """At process start no room job can be running yet, so anything not marked done was
    left by a previous run that died: mark it done so the finalizer takes it."""
    rootp = Path(root)
    if not rootp.is_dir():
        return 0
    n = 0
    for d in rootp.iterdir():
        m = read_manifest(d) if d.is_dir() else None
        if m is not None and not m.get("done"):
            m["done"] = True
            write_manifest(d, m)
            n += 1
    return n


def live_rooms(root: str | os.PathLike[str], stale_after_s: float = 6 * 3600, now: float | None = None) -> int:
    """How many room jobs are still running (spool open, not done, not abandoned)."""
    now = time.time() if now is None else now
    rootp = Path(root)
    if not rootp.is_dir():
        return 0
    n = 0
    for d in rootp.iterdir():
        m = read_manifest(d) if d.is_dir() else None
        if m is None or m.get("done"):
            continue
        newest = max((f.stat().st_mtime for f in d.iterdir() if f.is_file()), default=0.0)
        if now - newest <= stale_after_s:
            n += 1
    return n


def pending_dirs(root: str | os.PathLike[str], stale_after_s: float = 6 * 3600, now: float | None = None) -> list[Path]:
    """Room directories ready for the final pass: marked done, or abandoned by a job that
    died without marking (no write for `stale_after_s`)."""
    now = time.time() if now is None else now
    rootp = Path(root)
    if not rootp.is_dir():
        return []
    ready: list[Path] = []
    for d in sorted(p for p in rootp.iterdir() if p.is_dir()):
        m = read_manifest(d)
        if m is None:
            continue
        if m.get("done"):
            ready.append(d)
            continue
        newest = max((f.stat().st_mtime for f in d.iterdir() if f.is_file()), default=0.0)
        if now - newest > stale_after_s:
            ready.append(d)
    return ready
