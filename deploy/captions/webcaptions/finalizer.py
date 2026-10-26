"""The after-session transcript.

Once a room's job has ended, its spooled audio is transcribed again with the big model
(CAPTIONS_FINAL_MODEL, large-v3-turbo by default: beam search, VAD, context carried between
windows), each speaker on their own, and the whole session is posted as one timestamped
transcript. Slower than real time is fine — nobody is waiting on it — but it runs only while
the CPU guard says the host is idle, inside the same docker CPU cap, so a second webinar
starting on the box gets the CPU back at once.

Driven from a thread in the agent's main process, not in the room's job process: LiveKit
gives a job seconds to shut down, and a two-hour session takes far longer than that to redo.

The big model itself runs in a CHILD process (`python -m webcaptions.finalizer <dir>`,
ChildTranscribe), never in the main one. On 24 Oct 2026 the in-process pass loaded
large-v3-turbo (+1.2 GB) when a session ended, ran the container at its 2-core cap for 40
minutes, and then kept the model resident through the NEXT live session, because it only
unloaded once no room was pending (and CTranslate2 does not hand freed memory back to the
OS anyway): the container sat at 3.6 GB of its 4 GB limit during a live webinar. Now the
child is stopped the moment a room goes live (its memory and CPU are back at once), every
finished window is checkpointed in the room's directory (`final.progress`), and the next
child carries on from there.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
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
# Per-window checkpoint of a room's final pass. Not *.jsonl: those are the speakers' indexes.
PROGRESS = "final.progress"
# Exit codes of the child.
EXIT_DONE = 0
EXIT_STOPPED = 3


def build_chunks(
    entries: Sequence[spool.IndexEntry], max_chunk_s: float = 30.0, max_gap_s: float = 8.0
) -> list[list[spool.IndexEntry]]:
    """Consecutive utterances of one speaker, grouped into windows of at most `max_chunk_s`
    (Whisper's native 30 s) so the big model sees sentences with their context, never
    joined across a long silence.

    Whisper decodes a padded 30 s window whatever is in it: in production a 0.9 s window cost
    the same ~12 s of 2 cores as an 18 s one (24 Oct 2026). So pauses of up to `max_gap_s`
    (was 2 s) still join a window: fewer, fuller windows for the same transcript."""
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


def _load_progress(d: Path) -> dict[str, list[TranscriptLine]]:
    done: dict[str, list[TranscriptLine]] = {}
    try:
        text = (d / PROGRESS).read_text(encoding="utf-8")
    except OSError:
        return done
    for line in text.splitlines():
        try:
            j = json.loads(line)
            done[str(j["key"])] = [
                TranscriptLine(str(a), str(b), int(c), int(e), str(t)) for a, b, c, e, t in j["lines"]
            ]
        except (ValueError, KeyError, TypeError):
            continue  # a line cut short by a kill: that window is redone
    return done


def _save_progress(d: Path, key: str, lines: Sequence[TranscriptLine]) -> None:
    rec = {"key": key, "lines": [[l.identity, l.name, l.start_ms, l.end_ms, l.text] for l in lines]}
    with open(d / PROGRESS, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def transcribe_room(
    d: Path,
    transcriber: Transcriber | None,
    script: str,
    language: str | None,
    wait_ok: Callable[[], bool] = lambda: True,
    checkpoint: bool = False,
) -> list[TranscriptLine] | None:
    """Every speaker's audio in `d`, as transcript lines. None if `wait_ok` said stop.

    With `checkpoint`, windows already in `final.progress` are not decoded again and each new
    one is appended as soon as it is done, so a stopped pass loses at most one window.
    `transcriber` may be None only when every window is checkpointed (the parent collecting
    what the child decoded)."""
    done = _load_progress(d) if checkpoint else {}
    lines: list[TranscriptLine] = []
    for stem, entries in spool.read_index(d).items():
        previous: str | None = None
        for i, pieces in enumerate(build_chunks(entries)):
            key = f"{stem}/{i}/{pieces[0].start_ms}"
            if key in done:
                lines.extend(done[key])
                continue
            if not wait_ok():
                return None
            if transcriber is None:
                raise RuntimeError(f"window {key} of {d.name} was not transcribed")
            audio = np.concatenate([spool.read_pcm(d, stem, p.offset, p.samples) for p in pieces])
            got: list[TranscriptLine] = []
            if audio.size:
                res = transcriber.transcribe(audio, language=language, previous_language=previous, final=True)
                previous = res.language
                for seg in res.segments:
                    text = apply_script(seg.text, script).strip()
                    if not text:
                        continue
                    got.append(
                        TranscriptLine(
                            identity=pieces[0].identity,
                            name=pieces[0].name,
                            start_ms=chunk_time_to_wall(pieces, seg.start),
                            end_ms=chunk_time_to_wall(pieces, seg.end),
                            text=text,
                        )
                    )
            if checkpoint:
                _save_progress(d, key, got)
            lines.extend(got)
    lines.sort(key=lambda l: (l.start_ms, l.identity))
    return lines


class ChildTranscribe:
    """Runs a room's final pass in a child process and stops it whenever `busy()` says so
    (a room went live): ending the child is what gives the model's memory and the CPU back.
    The child checkpoints every window, so the next run carries on where it stopped.

    Called as transcribe(d, wait_ok), `wait_ok()` blocking until the host is idle (False when
    shutting down). Returns the room's lines, or None when shutting down."""

    def __init__(
        self,
        busy: Callable[[], bool],
        cfg: Config,
        poll_s: float = 2.0,
        argv: Sequence[str] | None = None,
    ) -> None:
        self.busy = busy
        self.cfg = cfg
        self.poll_s = poll_s
        self.argv = list(argv) if argv is not None else [sys.executable, "-m", "webcaptions.finalizer"]
        self.stopped = 0  # children stopped for a live room

    def __call__(self, d: Path, wait_ok: Callable[[], bool]) -> list[TranscriptLine] | None:
        while True:
            if not wait_ok():
                return None
            started = time.monotonic()
            child = subprocess.Popen([*self.argv, str(d)])
            stopped = False
            while child.poll() is None:
                try:
                    child.wait(self.poll_s)
                except subprocess.TimeoutExpired:
                    pass
                if child.poll() is None and self.busy():
                    log.info("final transcript: a room went live; stopping the pass for %s (resumes after)", d.name)
                    _stop(child)
                    stopped = True
                    self.stopped += 1
            code = child.returncode
            if stopped or code == EXIT_STOPPED:
                continue  # wait_ok() waits for the live room to end, then a new child resumes
            if code != EXIT_DONE:
                raise RuntimeError(f"final pass for {d.name} exited {code} after {time.monotonic() - started:.0f}s")
            return transcribe_room(d, None, self.cfg.script, self.cfg.whisper_language, checkpoint=True)


def _stop(child: subprocess.Popen) -> None:
    child.terminate()
    try:
        child.wait(10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


class Finalizer:
    def __init__(
        self,
        cfg: Config,
        api: ApiClient,
        transcriber: Transcriber,
        wait_until_idle: Callable[[threading.Event], bool],
        unload: Callable[[], None] = lambda: None,
        transcribe: Callable[[Path, Callable[[], bool]], list[TranscriptLine] | None] | None = None,
    ) -> None:
        """`transcribe(d, wait_ok)` makes a room's lines. Default: in this process with
        `transcriber` (the tests); the agent passes a ChildTranscribe. `transcriber.name` is
        the model the API is told about either way."""
        self.cfg = cfg
        self.api = api
        self.transcriber = transcriber
        self.wait_until_idle = wait_until_idle
        self.unload = unload
        self.stop = threading.Event()
        self.transcribe = transcribe or self._in_process

    def _in_process(self, d: Path, wait_ok: Callable[[], bool]) -> list[TranscriptLine] | None:
        return transcribe_room(d, self.transcriber, self.cfg.script, self.cfg.whisper_language, wait_ok=wait_ok)

    def process(self, d: Path) -> bool:
        """One room directory. True when it is finished with (posted or given up on)."""
        manifest = spool.read_manifest(d) or {}
        room = str(manifest.get("room", ""))
        if not room or not self.cfg.final_enabled:
            spool.remove(d)
            return True
        # Ask first: the pass is minutes of the big model. A load test's transcript is never
        # read, and a deleted webinar's would be refused (404). On 2026-10-26 one such pass
        # held the captions box at 91% for twenty minutes before its post got a 404.
        # "unknown" (the API unreachable or too old) carries on as before.
        wanted = self.api.transcript_wanted(room)
        if wanted in ("skip", "gone"):
            log.info("final transcript for %s: not needed (%s); dropping its audio", room, wanted)
            spool.remove(d)
            return True
        if not spool.read_index(d):
            # Still posted, with no lines: the API's AI recap is waiting for this transcript,
            # and without it would sit "processing" for its whole wait (30 min).
            log.info("final transcript: nobody spoke in %s; posting an empty transcript", room)
            lines: list[TranscriptLine] = []
        else:
            try:
                got = self.transcribe(d, lambda: self.wait_until_idle(self.stop))
            except Exception:
                # A child that crashed (or was OOM-killed) counts as an attempt: never a loop
                # reloading the big model every 30 s forever.
                log.exception("final transcript for %s failed", room)
                return self._attempt_failed(d, manifest)
            if got is None:
                return False  # shutting down; try again next start
            lines = got
        status = self.api.transcript(room, self.transcriber.name, lines)
        if 200 <= status < 300 or status in (400, 404, 413):
            # Posted, or the API will never take it (webinar deleted, malformed): either
            # way the audio has done its job and must not be kept.
            log.info("final transcript for %s: %d lines, API %d", room, len(lines), status)
            spool.remove(d)
            return True
        return self._attempt_failed(d, manifest)

    def _attempt_failed(self, d: Path, manifest: dict) -> bool:
        room = manifest.get("room", d.name)
        attempts = int(manifest.get("attempts", 0)) + 1
        if attempts >= MAX_ATTEMPTS:
            log.error("final transcript for %s: giving up after %d attempts", room, attempts)
            spool.remove(d)
            return True
        manifest["attempts"] = attempts
        spool.write_manifest(d, manifest)
        return False

    def resume(self) -> int:
        """At process start: every room a previous run left behind is taken up again.

        The spool is a docker volume, so a room whose transcript was being made (or not yet
        started) when the container was replaced is still on disk. No room job can be running
        this early, so one not marked done was cut off mid-session: it is marked done, and
        the loop transcribes and posts it like any other. A room whose post went through but
        whose audio was not yet deleted is posted again; the API merges a repeated transcript
        (store.TranscriptSince), so that is harmless. Returns how many rooms are pending."""
        if (n := spool.close_orphans(self.cfg.spool_dir)) > 0:
            log.info("final transcript: %d room(s) left mid-session by a previous run", n)
        pending = spool.pending_dirs(self.cfg.spool_dir)
        if pending:
            log.info(
                "final transcript: resuming %d room(s): %s",
                len(pending), ", ".join(str((spool.read_manifest(d) or {}).get("room", d.name)) for d in pending),
            )
        return len(pending)

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
            # In-process passes only (the tests): a child's model goes with the child.
            if not spool.pending_dirs(self.cfg.spool_dir):
                self.unload()
            self.stop.wait(every_s)


def idle_wait(busy: Callable[[], bool], poll_s: float = 10.0) -> Callable[[threading.Event], bool]:
    """A Finalizer's wait_until_idle: blocks while `busy()`; False once `stop` is set."""

    def wait(stop: threading.Event) -> bool:
        while busy():
            if stop.wait(poll_s):
                return False
        return not stop.is_set()

    return wait


def child_main(argv: Sequence[str]) -> int:
    """`python -m webcaptions.finalizer <room dir>`: one room's final pass, checkpointed.

    Exits EXIT_DONE once every window is in final.progress (the parent then posts it).
    Between windows it waits while the host is busy (its own CPU guard); the parent stops it
    with SIGTERM when a room goes live."""
    from .cpuguard import CpuGuard, GuardMonitor, Level, OthersCpuSampler
    from .transcriber import WhisperTranscriber

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    if len(argv) != 1:
        print("usage: python -m webcaptions.finalizer <room spool dir>", file=sys.stderr)
        return 2
    d = Path(argv[0])
    cfg = Config.from_env()
    try:
        os.nice(5)  # below the live agent's processes (nice 10 already, from the Dockerfile)
    except OSError:
        pass
    guard = GuardMonitor(
        CpuGuard(cfg.cpu_high, cfg.cpu_critical, cfg.cpu_low, cfg.cpu_high_for_s, cfg.cpu_low_for_s),
        cfg.cpu_sample_s,
        sampler=OthersCpuSampler(),  # its own decoding is not a reason to pause
    ).start()

    def wait_ok() -> bool:
        while guard.level != Level.NORMAL:
            time.sleep(cfg.cpu_sample_s)
        return True

    model = WhisperTranscriber(cfg.final_model, cfg.cpu_threads, cfg.model_dir)
    got = transcribe_room(d, model, cfg.script, cfg.whisper_language, wait_ok=wait_ok, checkpoint=True)
    return EXIT_DONE if got is not None else EXIT_STOPPED


if __name__ == "__main__":
    sys.exit(child_main(sys.argv[1:]))
