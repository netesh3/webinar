"""Live captions from Deepgram's streaming API (CAPTIONS_PROVIDER=deepgram).

Why: on the 2-vCPU captions box, base.en for one room of continuous speech held 60–83 % of
the box and the caption delay p90 was 7.8–9.5 s in the 2026-10-26 load tests
(docs/decisions/2026-10-27-captions-providers.md). Deepgram transcribes in its cloud and
sends interim words within a few hundred ms.

One websocket per subscribed speaker track (DeepgramStream), opened when the track's
pipeline starts and closed the moment it ends: Deepgram bills streamed audio, and an idle
socket is still a socket. Audio is sent only while the speaker is selected (selection.py,
the same gate the local model uses); in between, a KeepAlive message every few seconds
holds the socket open (Deepgram closes one that gets nothing for ~10 s).

Because audio is not sent continuously, Deepgram's timestamps (seconds of audio received)
are not wall-clock time. AudioClock keeps the wall time each run of sent audio began at and
maps a result's start/end back, so a line's startedAt/endedAt mean what a local line's do
(poster.py) and its partials and final share one caption id.

Results: an interim result is a partial (display only), an is_final result is a final
(stored, published), the same split LiveCaptioner makes for local lines. A socket that will
not connect or drops repeatedly (FailoverTracker) switches the room to the local models when
they are loaded (CAPTIONS_FALLBACK_LOCAL); otherwise it keeps retrying with backoff.

No LiveKit and no aiohttp at import time: the transport is a `connect(url, headers)` callable
(aiohttp's websocket in agent.py, a fake in tests).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse
from bisect import bisect_right
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Protocol

from .config import Config

log = logging.getLogger("captions.provider")

DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen"
SAMPLE_RATE = 16_000
BYTES_PER_MS = SAMPLE_RATE * 2 // 1000  # linear16 mono: 32 bytes per ms
KEEPALIVE_S = 5.0
CLOSE_WAIT_S = 2.0
# A run of sent audio more than this after where the last one ended starts a new anchor.
GAP_MS = 60


def listen_url(cfg: Config) -> str:
    """The streaming endpoint with this worker's settings: 16 kHz mono linear16 (what
    LiveKit's AudioStream gives us), interim results on, punctuation and formatting on."""
    q: dict[str, Any] = {
        "model": cfg.deepgram_model,
        "language": cfg.deepgram_language,
        "encoding": "linear16",
        "sample_rate": SAMPLE_RATE,
        "channels": 1,
        "interim_results": "true",
        "smart_format": "true",
        "punctuate": "true",
        "endpointing": cfg.deepgram_endpointing_ms,
    }
    if cfg.deepgram_utterance_end_ms:
        q["utterance_end_ms"] = cfg.deepgram_utterance_end_ms
    return DEEPGRAM_URL + "?" + urllib.parse.urlencode(q)


def auth_headers(cfg: Config) -> dict[str, str]:
    return {"Authorization": "Token " + cfg.deepgram_api_key}


@dataclass(frozen=True)
class Event:
    """One transcript result: kind "partial" or "final", seconds of streamed audio."""

    kind: str
    text: str
    start_s: float
    end_s: float


def parse_message(raw: str | bytes) -> Event | None:
    """A Deepgram message as an Event, or None for anything that is not transcript text
    (Metadata, SpeechStarted, UtteranceEnd, empty interim results)."""
    try:
        msg = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(msg, dict) or msg.get("type") != "Results":
        return None
    alts = (msg.get("channel") or {}).get("alternatives") or []
    text = " ".join(str(alts[0].get("transcript") or "").split()) if alts else ""
    if not text:
        return None
    start = float(msg.get("start") or 0.0)
    end = start + float(msg.get("duration") or 0.0)
    return Event("final" if msg.get("is_final") else "partial", text, start, end)


class AudioClock:
    """Maps seconds of audio sent on one socket back to wall-clock ms.

    Each run of audio sent without a gap is an anchor (audio ms at its start, wall ms at its
    start); inside a run, audio time and wall time advance together."""

    def __init__(self) -> None:
        self._audio: list[int] = []
        self._wall: list[int] = []
        self.sent_ms = 0  # audio sent so far
        self._last_wall_end: int | None = None

    def sent(self, nbytes: int, wall_ms: int) -> None:
        """`nbytes` of linear16 audio starting at `wall_ms` were sent."""
        dur = nbytes // BYTES_PER_MS
        if self._last_wall_end is None or abs(wall_ms - self._last_wall_end) > GAP_MS:
            self._audio.append(self.sent_ms)
            self._wall.append(wall_ms)
        self.sent_ms += dur
        self._last_wall_end = wall_ms + dur

    def wall_ms(self, audio_s: float) -> int:
        if not self._audio:
            return 0
        a = int(round(audio_s * 1000))
        i = max(0, bisect_right(self._audio, a) - 1)
        return self._wall[i] + (a - self._audio[i])


class FailoverTracker:
    """Decides when Deepgram has failed often enough to switch a room to the local models:
    `limit` failures (a connect that fails, or a socket that drops without being asked to)
    inside `window_s`. A success clears the count."""

    def __init__(self, limit: int = 3, window_s: float = 60.0, clock_s: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window_s = window_s
        self.clock_s = clock_s
        self._fails: list[float] = []
        self.tripped = False

    def failure(self) -> bool:
        now = self.clock_s()
        self._fails = [t for t in self._fails if now - t <= self.window_s] + [now]
        if len(self._fails) >= self.limit:
            self.tripped = True
        return self.tripped

    def success(self) -> None:
        self._fails.clear()

    def backoff_s(self) -> float:
        """Wait before the next connect attempt: 0.5, 1, 2, 4 … capped at 15 s."""
        return min(15.0, 0.5 * (2 ** max(0, len(self._fails) - 1)))


class Socket(Protocol):
    async def send_bytes(self, data: bytes) -> None: ...
    async def send_str(self, data: str) -> None: ...
    async def receive_str(self) -> str | None: ...  # None: the socket closed
    async def close(self) -> None: ...


Connect = Callable[[str, dict[str, str]], Awaitable[Socket]]
OnEvent = Callable[[str, int, int, str], None]  # kind, start wall ms, end wall ms, text


class DeepgramStream:
    """One speaker track's socket: `feed()` its audio (only while selected), results arrive
    through `on_event` with wall-clock times, `close()` when the track ends."""

    def __init__(
        self,
        cfg: Config,
        key: str,
        connect: Connect,
        on_event: OnEvent,
        tracker: FailoverTracker,
        clock_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        self.cfg = cfg
        self.key = key
        self.connect = connect
        self.on_event = on_event
        self.tracker = tracker
        self.clock_ms = clock_ms
        self.clock = AudioClock()
        self.ws: Socket | None = None
        self._reader: asyncio.Task[None] | None = None
        self._keepalive: asyncio.Task[None] | None = None
        self._connecting: asyncio.Task[None] | None = None
        self._closing = False
        self._last_send_s = time.monotonic()
        self._retry_at = 0.0
        self.finals = 0
        self.partials = 0

    # ---------------------------------------------------------------- audio

    async def feed(self, pcm16: bytes, wall_ms: int) -> None:
        """Send one frame. While the socket is (re)connecting the frame is dropped: a
        caption of audio from seconds ago is worth less than not blocking the pipeline."""
        if self._closing or self.tracker.tripped:
            return
        if self.ws is None:
            self._ensure_connecting()
            return
        try:
            await self.ws.send_bytes(pcm16)
        except Exception as err:
            self._lost(f"send failed: {err}")
            return
        self.clock.sent(len(pcm16), wall_ms)
        self._last_send_s = time.monotonic()

    # ----------------------------------------------------------- connection

    def _ensure_connecting(self) -> None:
        if self._connecting is not None or self._closing or time.monotonic() < self._retry_at:
            return
        self._connecting = asyncio.ensure_future(self._connect())

    async def _connect(self) -> None:
        try:
            self.ws = await self.connect(listen_url(self.cfg), auth_headers(self.cfg))
        except Exception as err:
            # The error text is the transport's (status, reason), never the key.
            log.warning("deepgram: connect for %s failed: %s", self.key, err)
            self.tracker.failure()
            self._retry_at = time.monotonic() + self.tracker.backoff_s()
            return
        finally:
            self._connecting = None
        self.tracker.success()
        self.clock = AudioClock()  # offsets restart on every socket
        log.info("deepgram: stream open for %s (%s, %s)", self.key, self.cfg.deepgram_model, self.cfg.deepgram_language)
        self._reader = asyncio.ensure_future(self._read(self.ws))
        self._keepalive = asyncio.ensure_future(self._keep_alive(self.ws))

    def _lost(self, why: str) -> None:
        if self._closing:
            return
        log.warning("deepgram: stream for %s lost (%s)", self.key, why)
        self.tracker.failure()
        self._retry_at = time.monotonic() + self.tracker.backoff_s()
        ws, self.ws = self.ws, None
        for t in (self._keepalive,):
            if t is not None:
                t.cancel()
        if ws is not None:
            asyncio.ensure_future(_quiet_close(ws))

    async def _read(self, ws: Socket) -> None:
        while True:
            try:
                raw = await ws.receive_str()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                if self.ws is ws:
                    self._lost(f"receive failed: {err}")
                return
            if raw is None:
                if self.ws is ws:
                    self._lost("closed by Deepgram")
                return
            ev = parse_message(raw)
            if ev is None:
                continue
            start, end = self.clock.wall_ms(ev.start_s), self.clock.wall_ms(ev.end_s)
            if ev.kind == "final":
                self.finals += 1
            else:
                self.partials += 1
            try:
                self.on_event(ev.kind, start, end, ev.text)
            except Exception:
                log.exception("deepgram: result handler failed for %s", self.key)

    async def _keep_alive(self, ws: Socket) -> None:
        while True:
            await asyncio.sleep(1.0)
            if time.monotonic() - self._last_send_s >= KEEPALIVE_S:
                try:
                    await ws.send_str('{"type":"KeepAlive"}')
                except Exception as err:
                    if self.ws is ws:
                        self._lost(f"keepalive failed: {err}")
                    return
                self._last_send_s = time.monotonic()

    async def close(self) -> None:
        """The track ended: ask Deepgram for the last results, give them a moment, close."""
        self._closing = True
        if self._connecting is not None:
            self._connecting.cancel()
        if self._keepalive is not None:
            self._keepalive.cancel()
        ws, self.ws = self.ws, None
        if ws is not None:
            try:
                await ws.send_str('{"type":"CloseStream"}')
            except Exception:
                pass
            if self._reader is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(self._reader), CLOSE_WAIT_S)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    pass
            await _quiet_close(ws)
        if self._reader is not None and not self._reader.done():
            self._reader.cancel()
        log.info("deepgram: stream for %s closed (%d finals, %d partials)", self.key, self.finals, self.partials)


async def _quiet_close(ws: Socket) -> None:
    try:
        await ws.close()
    except Exception:
        pass


def aiohttp_connect() -> Connect:
    """The production transport: aiohttp's websocket client (aiohttp ships with
    livekit-agents). Imported here, not at module load, so tests need no aiohttp."""
    import aiohttp

    session: list[aiohttp.ClientSession] = []

    class _WS:
        def __init__(self, ws: aiohttp.ClientWebSocketResponse) -> None:
            self.ws = ws

        async def send_bytes(self, data: bytes) -> None:
            await self.ws.send_bytes(data)

        async def send_str(self, data: str) -> None:
            await self.ws.send_str(data)

        async def receive_str(self) -> str | None:
            msg = await self.ws.receive()
            if msg.type == aiohttp.WSMsgType.TEXT:
                return msg.data
            if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                return None
            return ""  # binary or ping: nothing for us

        async def close(self) -> None:
            await self.ws.close()

    async def connect(url: str, headers: dict[str, str]) -> Socket:
        if not session or session[0].closed:
            session[:] = [aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, connect=10))]
        ws = await session[0].ws_connect(url, headers=headers, heartbeat=20.0, max_msg_size=4 * 1024 * 1024)
        return _WS(ws)

    return connect
