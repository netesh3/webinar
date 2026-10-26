"""The live half of one room: utterances in, captions out.

No LiveKit here (agent.py feeds it), so the decisions — which model, what to skip, what to
post, when to tell the API it is paused — are testable with a fake transcriber.

One utterance is decoded at a time per room. That is the CPU bound that matters: two
speakers talking over each other queue rather than run two decoders, and a backlog is
dropped (old captions are worse than none) instead of growing.

Where a line goes, fastest first:

  * the room itself: the agent publishes the "caption" packet to the SFU it sits beside
    (`publish`), when the room's metadata says captions are shown. That is the display path
    for everyone in the LiveKit room;
  * the API, always, for finals, on a background thread (`post_async`): it stores the line
    for the AI and copies it to the edge (LL-HLS) audience, who are not in the room. When
    the agent could not publish, the API relays to the room too, as it always did.

Partials (interim text for the line still being spoken) share the one decoder but never
delay a final by more than one partial decode: finals are always taken first, there is at
most one partial waiting (a newer one replaces it), and they run only in NORMAL. They are
display-only: published to the room, posted to the API only for an edge room (which
forwards them to the edge audience and stores nothing), never spooled.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

import numpy as np

from .config import Config
from .cpuguard import Level
from .metrics import LatencyStats
from .poster import ApiClient, caption_id, caption_packet, sender_for
from .segmenter import Utterance
from .spool import RoomSpool
from .transcriber import Transcriber

log = logging.getLogger("captions.live")

# A provider line carries no audio here: its audio was spooled as it arrived (spool_only).
_NO_AUDIO = np.zeros(0, np.float32)

# A caption older than this when its turn comes is skipped: the speaker has moved on.
MAX_LAG_S = 12.0
MAX_LAG_DEGRADED_S = 6.0
MAX_QUEUE = 6
# A partial still waiting this long after it was taken is stale: a newer one is due.
PARTIAL_STALE_MS = 1500


@dataclass
class Pending:
    identity: str
    name: str
    utterance: Utterance
    # A streaming provider's line has its end from the provider's timing, not from audio
    # held here (deliver()).
    ended_at_ms: int | None = None

    @property
    def end_ms(self) -> int:
        if self.ended_at_ms is not None:
            return self.ended_at_ms
        return self.utterance.started_at_ms + int(self.utterance.duration_s * 1000)

    @property
    def id(self) -> str:
        return caption_id(self.identity, self.utterance.started_at_ms)


def _sync(fn: Callable[[], None]) -> None:
    fn()


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
        *,
        partial: Transcriber | None = None,
        publish: Callable[[dict], bool] | None = None,
        display: Callable[[], bool | None] = lambda: None,
        sender_of: Callable[[str, str], dict] = lambda identity, name: sender_for(identity, name, None),
        post_async: Callable[[Callable[[], None]], None] = _sync,
        stats: LatencyStats | None = None,
    ) -> None:
        """`publish(packet)` puts a packet on the room, True when handed to the SFU.
        `display()` is the room's captions switch as its metadata says: True shown, False
        hidden (AI transcript only), None not known yet (then nothing is published here and
        the API relays). `post_async(fn)` runs fn off the decoder (one worker, in order)."""
        self.cfg = cfg
        self.api = api
        self.room = room
        self.live = live
        self.fallback = fallback
        self.level = level
        self.spool = spool
        self.clock_ms = clock_ms
        self.queue: deque[Pending] = deque()
        self.captions_off = False
        self.posted = 0
        self.skipped = 0
        self._lock = threading.Lock()
        self._reported: str | None = None
        self.partial_model = partial or fallback
        self.publish = publish
        self.display = display
        self.sender_of = sender_of
        self.post_async = post_async
        self.stats = stats or LatencyStats(room)
        # From the API's answer to the last final: an edge room's audience is not in the
        # LiveKit room, so partials are posted to the API only then.
        self.edge = False
        self.partial: Pending | None = None
        self._partial_taken_ms = 0
        self._partial_post_busy = False
        self._finalised: deque[str] = deque(maxlen=32)
        self.partials_posted = 0

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

    def transcriber_for(self, level: Level) -> Transcriber:
        return self.fallback if level == Level.DEGRADED else self.live

    def process(self, p: Pending) -> str | None:
        """Decode one utterance, publish it to the room and post it to the API. Returns the
        text (None when there was nothing to say, or the API has refused it)."""
        level = self.level()
        if level >= Level.PAUSED or self.captions_off:
            return None
        started = self.clock_ms()
        self.stats.record("queue", started - p.end_ms)
        with self._lock:
            # From here a partial of this line is worse than nothing: the final is coming.
            self._finalised.append(p.id)
            if self.partial is not None and self.partial.id == p.id:
                self.partial = None
        model = self.transcriber_for(level)
        res = model.transcribe(p.utterance.audio, language=self.cfg.whisper_language, final=False)
        self.stats.record("decode", self.clock_ms() - started)
        return self._deliver_final(p, res.text.strip())

    def _deliver_final(self, p: Pending, text: str) -> str | None:
        """A final line's text, from the local model or a streaming provider: publish it to
        the room and post it to the API (off the caller's thread)."""
        if not text:
            self.stats.maybe_log()
            return None
        published = self._publish(p, text, partial=False)
        if published:
            self.stats.record("e2e", self.clock_ms() - p.end_ms)
        self.stats.count("finals")
        accepted: list[bool] = []

        def post() -> None:
            t0 = self.clock_ms()
            status, body = self.api.caption_line(
                self.room, p.identity, text, p.utterance.started_at_ms, p.end_ms, published=published
            )
            t1 = self.clock_ms()
            self.stats.record("post", t1 - t0)
            self.stats.record("api_lag", t1 - p.end_ms)
            if status == 409:
                # The host switched off; the dispatch is on its way out. Stop decoding.
                log.info("API says captions are off in %s; standing by", self.room)
                self.captions_off = True
            elif 200 <= status < 300:
                self.posted += 1
                self.edge = bool(body.get("edge"))
                accepted.append(True)
                if not published:
                    self.stats.record("e2e", t1 - p.end_ms)  # the API's relay was the display path

        self.post_async(post)
        self.stats.maybe_log()
        if self.captions_off:
            return None
        return text if (accepted or published) else None

    def _publish(self, p: Pending, text: str, partial: bool) -> bool:
        if not (self.cfg.direct_publish and self.publish is not None) or self.display() is not True:
            return False
        packet = caption_packet(
            self.sender_of(p.identity, p.name), text, p.utterance.started_at_ms, p.end_ms, self.clock_ms(), partial
        )
        try:
            return bool(self.publish(packet))
        except Exception:
            log.exception("caption publish failed in %s", self.room)
            return False

    def process_next(self) -> str | None:
        p = self.next_pending()
        return self.process(p) if p else None

    # ------------------------------------------- text from a streaming provider

    def spool_only(self, identity: str, name: str, utt: Utterance) -> None:
        """A streaming provider transcribes live; the utterance is only kept for the
        after-session transcript (never queued for a local decode)."""
        if self.spool is not None and self.cfg.final_enabled:
            self.spool.write(identity, name, utt.audio, utt.started_at_ms)

    def deliver(self, identity: str, name: str, text: str, started_ms: int, end_ms: int, *, partial: bool) -> str | None:
        """Text a streaming provider (provider.py) already transcribed: a final is published
        and posted as a locally decoded one is, a partial only shown (same rules as
        process_partial). Returns the text when it went anywhere."""
        if self.captions_off or self.level() >= Level.PAUSED:
            self.skipped += 0 if partial else 1
            return None
        utt = Utterance(audio=_NO_AUDIO, started_at_ms=int(started_ms), voiced_s=max(0.0, (end_ms - started_ms) / 1000))
        p = Pending(identity, name, utt, ended_at_ms=int(end_ms))
        text = (text or "").strip()
        if not partial:
            with self._lock:
                self._finalised.append(p.id)
            return self._deliver_final(p, text)
        if not text or not self.partials_allowed():
            return None
        with self._lock:
            if p.id in self._finalised:
                return None
        shown = self._publish(p, text, partial=True)
        if self.edge and not self._partial_post_busy:
            self._partial_post_busy = True

            def post() -> None:
                try:
                    status, _ = self.api.caption_line(
                        self.room, identity, text, p.utterance.started_at_ms, p.end_ms, partial=True, published=True
                    )
                    if 200 <= status < 300:
                        self.partials_posted += 1
                finally:
                    self._partial_post_busy = False

            self.post_async(post)
            shown = True
        if shown:
            self.stats.count("partials")
        return text if shown else None

    # ------------------------------------------------------------ partials

    def partials_allowed(self) -> bool:
        """Interim captions cost decodes: only in NORMAL, only while captions are shown,
        and only where someone can be shown them (the room, or an edge audience)."""
        if not self.cfg.partials or self.captions_off or self.level() != Level.NORMAL:
            return False
        if self.display() is not True:
            return False
        return (self.cfg.direct_publish and self.publish is not None) or self.edge

    def offer_partial(self, identity: str, name: str, utt: Utterance) -> bool:
        """The main speaker's line so far. Replaces any partial not decoded yet."""
        if not self.partials_allowed():
            return False
        p = Pending(identity, name, utt)
        with self._lock:
            if p.id in self._finalised:
                return False
            self.partial = p
            self._partial_taken_ms = self.clock_ms()
        return True

    def next_partial(self) -> Pending | None:
        """The partial to decode now, if any. Finals come first: with one waiting, the
        partial stays put (call next_pending first)."""
        with self._lock:
            p = self.partial
            if p is None or self.queue:
                return None
            self.partial = None
            if p.id in self._finalised or self.clock_ms() - self._partial_taken_ms > PARTIAL_STALE_MS:
                return None
        return p if self.partials_allowed() else None

    def process_partial(self, p: Pending) -> str | None:
        """Decode the line so far with the partial model and show it. Never stored."""
        if not self.partials_allowed():
            return None
        t0 = self.clock_ms()
        res = self.partial_model.transcribe(p.utterance.audio, language=self.cfg.whisper_language, final=False)
        self.stats.record("partial", self.clock_ms() - t0)
        text = res.text.strip()
        with self._lock:
            if not text or p.id in self._finalised:
                return None  # the final is out, or on its way, and says it better
        shown = self._publish(p, text, partial=True)
        if self.edge and not self._partial_post_busy:
            # The edge audience gets partials through the API. One in flight at a time: a
            # slow API skips partials rather than queueing them up behind the finals.
            self._partial_post_busy = True

            def post() -> None:
                try:
                    status, _ = self.api.caption_line(
                        self.room, p.identity, text, p.utterance.started_at_ms, p.end_ms, partial=True, published=True
                    )
                    if 200 <= status < 300:
                        self.partials_posted += 1
                finally:
                    self._partial_post_busy = False

            self.post_async(post)
            shown = True
        if shown:
            self.stats.count("partials")
        return text if shown else None

    # -------------------------------------------------------------- status

    def report(self, level: Level | None = None, stopped: bool = False) -> str | None:
        """Tell the API whether the browsers should caption themselves. Only on change."""
        level = self.level() if level is None else level
        state = "stopped" if stopped else ("paused" if level >= Level.PAUSED else "live")
        if state == self._reported:
            return None
        self._reported = state
        _, body = self.api.status_json(self.room, state)
        # The API says whether the room is on edge delivery (its audience is not in the
        # LiveKit room), so partials can reach them from the first line.
        if "edge" in body:
            self.edge = bool(body["edge"])
        return state
