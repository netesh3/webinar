"""The live half of one room: utterances in, captions out.

No LiveKit here (agent.py feeds it), so the decisions — which model, what to skip, what to
post, when to tell the API it is paused — are testable with a fake transcriber.

One utterance is decoded at a time per room. That is the CPU bound that matters: two
speakers talking over each other queue rather than run two decoders, and a backlog is
dropped (old captions are worse than none) instead of growing.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

from .config import Config
from .cpuguard import Level
from .poster import ApiClient
from .roman import apply_script
from .segmenter import Utterance
from .spool import RoomSpool
from .transcriber import Transcriber

log = logging.getLogger("captions.live")

# A caption older than this when its turn comes is skipped: the speaker has moved on.
MAX_LAG_S = 12.0
MAX_LAG_DEGRADED_S = 6.0
MAX_QUEUE = 6
# Language re-detection cadence in auto mode: see language_for.
REDETECT_EVERY = 3


@dataclass
class Pending:
    identity: str
    name: str
    utterance: Utterance

    @property
    def end_ms(self) -> int:
        return self.utterance.started_at_ms + int(self.utterance.duration_s * 1000)


class LiveCaptioner:
    def __init__(
        self,
        cfg: Config,
        api: ApiClient,
        room: str,
        live: Transcriber,
        fallback: Transcriber,
        level: Callable[[], Level],
        spool: RoomSpool | None = None,
        clock_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        self.cfg = cfg
        self.api = api
        self.room = room
        self.live = live
        self.fallback = fallback
        self.level = level
        self.spool = spool
        self.clock_ms = clock_ms
        self.queue: deque[Pending] = deque()
        self.languages: dict[str, str] = {}
        self._since_detect: dict[str, int] = {}
        self.captions_off = False
        self.posted = 0
        self.skipped = 0
        self._lock = threading.Lock()
        self._reported: str | None = None

    # -------------------------------------------------------------- input

    def add(self, identity: str, name: str, utt: Utterance) -> None:
        """A finished utterance from one speaker. Always spooled; decoded unless paused."""
        if self.spool is not None and self.cfg.final_enabled:
            self.spool.write(identity, name, utt.audio, utt.started_at_ms)
        if self.captions_off or self.level() >= Level.PAUSED:
            self.skipped += 1
            return
        with self._lock:
            if self.level() == Level.DEGRADED:
                # Skip windows: only the newest utterance per speaker is worth decoding.
                self.queue = deque(p for p in self.queue if p.identity != identity)
            self.queue.append(Pending(identity, name, utt))
            while len(self.queue) > MAX_QUEUE:
                self.queue.popleft()
                self.skipped += 1

    # ------------------------------------------------------------ decoding

    def next_pending(self) -> Pending | None:
        level = self.level()
        max_lag = MAX_LAG_DEGRADED_S if level == Level.DEGRADED else MAX_LAG_S
        now = self.clock_ms()
        with self._lock:
            while self.queue:
                p = self.queue.popleft()
                if level >= Level.PAUSED or self.captions_off:
                    self.skipped += 1
                    continue
                if now - p.end_ms > max_lag * 1000:
                    self.skipped += 1
                    continue
                return p
        return None

    def language_for(self, identity: str) -> str | None:
        """The language to decode a speaker's next utterance in; None means detect it.

        Detection is a second pass of the encoder, so in auto mode it runs on a speaker's
        first utterance and then one in every REDETECT_EVERY + 1, the language in between
        being the speaker's last. Someone switching from English to Hindi is picked up
        within a few lines."""
        if self.cfg.whisper_language is not None:
            return self.cfg.whisper_language
        previous = self.languages.get(identity)
        n = self._since_detect.get(identity, 0)
        if previous is None or n >= REDETECT_EVERY:
            self._since_detect[identity] = 0
            return None
        self._since_detect[identity] = n + 1
        return previous

    def transcriber_for(self, level: Level) -> Transcriber:
        return self.fallback if level == Level.DEGRADED else self.live

    def process(self, p: Pending) -> str | None:
        """Decode and post one utterance. Returns the posted text."""
        level = self.level()
        if level >= Level.PAUSED or self.captions_off:
            return None
        model = self.transcriber_for(level)
        res = model.transcribe(
            p.utterance.audio,
            language=self.language_for(p.identity),
            previous_language=self.languages.get(p.identity),
            final=False,
        )
        self.languages[p.identity] = res.language
        text = apply_script(res.text, self.cfg.script).strip()
        if not text:
            return None
        status = self.api.caption(self.room, p.identity, text, p.utterance.started_at_ms)
        if status == 409:
            # The host switched off; the dispatch is on its way out. Stop decoding.
            log.info("API says captions are off in %s; standing by", self.room)
            self.captions_off = True
            return None
        if 200 <= status < 300:
            self.posted += 1
            return text
        return None

    def process_next(self) -> str | None:
        p = self.next_pending()
        return self.process(p) if p else None

    # -------------------------------------------------------------- status

    def report(self, level: Level | None = None, stopped: bool = False) -> str | None:
        """Tell the API whether the browsers should caption themselves. Only on change."""
        level = self.level() if level is None else level
        state = "stopped" if stopped else ("paused" if level >= Level.PAUSED else "live")
        if state == self._reported:
            return None
        self._reported = state
        self.api.status(self.room, state)
        return state
