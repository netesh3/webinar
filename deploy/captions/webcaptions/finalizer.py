"""The after-session transcript.

Once a room's job has ended, its spooled audio is transcribed again with the big model
(CAPTIONS_FINAL_MODEL, large-v3-turbo by default: beam search, VAD, context carried between
windows), each speaker on their own, and the whole session is posted as one timestamped
transcript. Slower than real time is fine — nobody is waiting on it — but it runs only while
the CPU guard says the host is idle, inside the same docker CPU cap, so a second webinar
starting on the box gets the CPU back at once.

Runs on a thread in the agent's main process, not in the room's job process: LiveKit gives
a job seconds to shut down, and a two-hour session takes far longer than that to redo.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from . import spool
from .config import Config
from .poster import ApiClient, TranscriptLine
from .roman import apply_script
from .transcriber import Transcriber

log = logging.getLogger("captions.finalizer")

SAMPLE_RATE = spool.SAMPLE_RATE
MAX_ATTEMPTS = 5


def build_chunks(
    entries: Sequence[spool.IndexEntry], max_chunk_s: float = 30.0, max_gap_s: float = 2.0
) -> list[list[spool.IndexEntry]]:
    """Consecutive utterances of one speaker, grouped into windows of at most `max_chunk_s`
    (Whisper's native 30 s) so the big model sees sentences with their context, never
    joined across a long silence."""
    chunks: list[list[spool.IndexEntry]] = []
    cur: list[spool.IndexEntry] = []
    cur_n = 0
    limit = int(max_chunk_s * SAMPLE_RATE)
    for e in sorted(entries, key=lambda x: x.start_ms):
        if cur:
            prev = cur[-1]
            prev_end = prev.start_ms + prev.samples * 1000 // SAMPLE_RATE
            if cur_n + e.samples > limit or e.start_ms - prev_end > max_gap_s * 1000:
                chunks.append(cur)
                cur, cur_n = [], 0
        cur.append(e)
        cur_n += e.samples
    if cur:
        chunks.append(cur)
    return chunks


def chunk_time_to_wall(pieces: Sequence[spool.IndexEntry], t_s: float) -> int:
    """A time inside the concatenated chunk, back to the wall clock (Unix ms)."""
    pos = max(0.0, t_s) * SAMPLE_RATE
    acc = 0
    for i, p in enumerate(pieces):
        if pos < acc + p.samples or i == len(pieces) - 1:
            within = min(pos - acc, p.samples)
            return p.start_ms + int(round(within * 1000 / SAMPLE_RATE))
        acc += p.samples
    return pieces[-1].start_ms if pieces else 0


def transcribe_room(
    d: Path,
    transcriber: Transcriber,
    script: str,
    language: str | None,
    wait_ok: Callable[[], bool] = lambda: True,
) -> list[TranscriptLine] | None:
    """Every speaker's audio in `d`, as transcript lines. None if `wait_ok` said stop."""
    lines: list[TranscriptLine] = []
    for stem, entries in spool.read_index(d).items():
        previous: str | None = None
        for pieces in build_chunks(entries):
            if not wait_ok():
                return None
            audio = np.concatenate([spool.read_pcm(d, stem, p.offset, p.samples) for p in pieces])
            if audio.size == 0:
                continue
            res = transcriber.transcribe(audio, language=language, previous_language=previous, final=True)
            previous = res.language
            for seg in res.segments:
                text = apply_script(seg.text, script).strip()
                if not text:
                    continue
                lines.append(
                    TranscriptLine(
                        identity=pieces[0].identity,
                        name=pieces[0].name,
                        start_ms=chunk_time_to_wall(pieces, seg.start),
                        end_ms=chunk_time_to_wall(pieces, seg.end),
                        text=text,
                    )
                )
    lines.sort(key=lambda l: (l.start_ms, l.identity))
    return lines


class Finalizer:
    def __init__(
        self,
        cfg: Config,
        api: ApiClient,
        transcriber: Transcriber,
        wait_until_idle: Callable[[threading.Event], bool],
        unload: Callable[[], None] = lambda: None,
    ) -> None:
        self.cfg = cfg
        self.api = api
        self.transcriber = transcriber
        self.wait_until_idle = wait_until_idle
        self.unload = unload
        self.stop = threading.Event()

    def process(self, d: Path) -> bool:
        """One room directory. True when it is finished with (posted or given up on)."""
        manifest = spool.read_manifest(d) or {}
        room = str(manifest.get("room", ""))
        if not room or not self.cfg.final_enabled:
            spool.remove(d)
            return True
        if not spool.read_index(d):
            log.info("final transcript: nobody spoke in %s", room)
            spool.remove(d)
            return True
        lines = transcribe_room(
            d, self.transcriber, self.cfg.script, self.cfg.whisper_language,
            wait_ok=lambda: self.wait_until_idle(self.stop),
        )
        if lines is None:
            return False  # shutting down; try again next start
        status = self.api.transcript(room, self.transcriber.name, lines)
        if 200 <= status < 300 or status in (400, 404, 413):
            # Posted, or the API will never take it (webinar deleted, malformed): either
            # way the audio has done its job and must not be kept.
            log.info("final transcript for %s: %d lines, API %d", room, len(lines), status)
            spool.remove(d)
            return True
        attempts = int(manifest.get("attempts", 0)) + 1
        if attempts >= MAX_ATTEMPTS:
            log.error("final transcript for %s: giving up after %d attempts", room, attempts)
            spool.remove(d)
            return True
        manifest["attempts"] = attempts
        spool.write_manifest(d, manifest)
        return False

    def run_once(self) -> int:
        done = 0
        for d in spool.pending_dirs(self.cfg.spool_dir):
            if self.stop.is_set():
                break
            try:
                if self.process(d):
                    done += 1
            except Exception:
                log.exception("final transcript failed for %s", d.name)
        return done

    def loop(self, every_s: float = 30.0) -> None:
        while not self.stop.is_set():
            self.run_once()
            # The big model is ~1.5 GB resident; give it back between sessions.
            if not spool.pending_dirs(self.cfg.spool_dir):
                self.unload()
            self.stop.wait(every_s)
