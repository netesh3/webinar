"""Live captions from Deepgram's streaming API (CAPTIONS_PROVIDER=deepgram), on the video box.

Why: on the 2-vCPU captions box, base.en for one room of continuous speech held 60–83 % of
the box and the caption delay p90 was 7.8–9.5 s in the 2026-10-26 load tests
(docs/decisions/2026-10-27-captions-providers.md). Deepgram transcribes in its cloud and sends
interim words within a few hundred ms; the worker that feeds it is light enough (a voice
activity detector and a websocket per speaker, no Whisper) to run on the video box itself.

Per stage speaker's microphone track (agent.py):

  * SileroVad scores each 32 ms window (the ~2 MB Silero model, onnxruntime, one thread).
  * SpeechGate turns those scores into what the socket should do: open when speech starts,
    sending the ~400 ms before it first (the pre-roll, so the first word is not cut); send
    while speaking; ask Deepgram to finalise after ~0.5 s of silence; keep the socket for a
    ~9 s hangover in case the speaker carries on; close after that, or at once on mute,
    unpublish or leave. Only the pre-roll and speech are ever sent: Deepgram bills streamed
    audio, and between utterances the socket gets only KeepAlive messages.
  * DeepgramStream is the socket: audio sent while it is still connecting is held and sent
    when it opens (nothing is lost to the handshake); a dropped socket reconnects with backoff;
    results come back as partials (interim) and finals (is_final), with AudioClock mapping
    Deepgram's offsets (seconds of audio received) back to wall-clock time across the gaps.
  * CostStats logs, per room per minute, the audio sent, the time connected and the sockets
    opened and closed (the captions.cost line), so the bill is visible.

No LiveKit and no aiohttp or onnxruntime at import time: the socket is a `connect(url, headers)`
callable (aiohttp's in agent.py, a fake in tests) and the VAD model is loaded on demand.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse
from bisect import bisect_right
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Protocol

import numpy as np

from .config import Config

log = logging.getLogger("captions.provider")
cost_log = logging.getLogger("captions.cost")

DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen"
SAMPLE_RATE = 16_000
FRAME_MS = 10  # LiveKit's AudioStream frames (agent.py)
BYTES_PER_MS = SAMPLE_RATE * 2 // 1000  # linear16 mono: 32 bytes per ms
KEEPALIVE_S = 5.0
CLOSE_WAIT_S = 2.0
CONNECTING_BUFFER_MS = 4000  # audio held while a socket connects
GAP_MS = 60  # a run of sent audio more than this after the last one starts a new clock anchor
VAD_WINDOW = 512  # Silero's window at 16 kHz (32 ms)


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
    (Metadata, SpeechStarted, UtteranceEnd, empty results)."""
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
        self.sent_ms = 0
        self._last_wall_end: int | None = None

    def sent(self, nbytes: int, wall_ms: int) -> None:
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


# ------------------------------------------------------------------ gating


class SpeechGate:
    """What one speaker's socket should do, frame by frame (10 ms), from the VAD's latest
    speech probability. Pure: push() returns actions, the caller performs them:

        ("open",)              connect (or reuse the socket still open from the hangover)
        ("send", pcm, wall_ms) stream this frame
        ("finalize",)          the utterance ended: ask Deepgram for its final now
        ("close",)             the hangover ran out (or mute/leave): close the socket

    States: idle (no socket), speaking (sending), quiet (socket kept, nothing sent)."""

    def __init__(
        self,
        preroll_ms: int = 400,
        hangover_s: float = 9.0,
        end_silence_ms: int = 500,
        on: float = 0.5,
        off: float = 0.35,
        min_speech_ms: int = 60,
    ) -> None:
        self.preroll: deque[tuple[bytes, int]] = deque(maxlen=max(1, preroll_ms // FRAME_MS))
        self.hangover_ms = int(hangover_s * 1000)
        self.end_silence_ms = end_silence_ms
        self.on, self.off = on, off
        self.min_speech_ms = min_speech_ms
        self.state = "idle"
        self._voiced_ms = 0
        self._silence_ms = 0
        self._quiet_ms = 0

    def push(self, pcm: bytes, wall_ms: int, prob: float | None) -> list[tuple]:
        p = 0.0 if prob is None else prob
        out: list[tuple] = []
        if self.state == "speaking":
            out.append(("send", pcm, wall_ms))
            self._silence_ms = self._silence_ms + FRAME_MS if p < self.off else 0
            if self._silence_ms >= self.end_silence_ms:
                out.append(("finalize",))
                self.state, self._quiet_ms, self._voiced_ms = "quiet", 0, 0
            return out
        self.preroll.append((pcm, wall_ms))
        if p >= self.on:
            self._voiced_ms += FRAME_MS
            if self._voiced_ms >= self.min_speech_ms:
                if self.state == "idle":
                    out.append(("open",))
                out.extend(("send", f, w) for f, w in self.preroll)  # pre-roll, current frame last
                self.preroll.clear()
                self.state, self._silence_ms = "speaking", 0
            return out
        self._voiced_ms = 0
        if self.state == "quiet":
            self._quiet_ms += FRAME_MS
            if self._quiet_ms >= self.hangover_ms:
                out.append(("close",))
                self.state = "idle"
        return out

    def force_close(self) -> list[tuple]:
        """Mute, unpublish or leave: close now, whatever the state; forget the pre-roll."""
        out: list[tuple] = [("close",)] if self.state != "idle" else []
        self.state, self._voiced_ms, self._silence_ms, self._quiet_ms = "idle", 0, 0, 0
        self.preroll.clear()
        return out


class SileroVad:
    """Silero VAD over one track's 16 kHz audio: push 10 ms frames, read the latest window's
    speech probability. `session` is shared by every track of the process (load_session); the
    model state is per track."""

    def __init__(self, session: Any) -> None:
        from livekit.plugins.silero.onnx_model import OnnxModel

        self.model = OnnxModel(onnx_session=session, sample_rate=SAMPLE_RATE)
        self._buf = np.zeros(0, np.float32)
        self.prob: float | None = None

    @staticmethod
    def load_session() -> Any:
        """The ~2 MB Silero model shipped with livekit-plugins-silero, CPU, one thread."""
        from livekit.plugins.silero.onnx_model import new_inference_session

        return new_inference_session(force_cpu=True)

    def push(self, samples: np.ndarray) -> float | None:
        self._buf = np.concatenate([self._buf, samples.astype(np.float32, copy=False)])
        while len(self._buf) >= VAD_WINDOW:
            self.prob = float(self.model(self._buf[:VAD_WINDOW]))
            self._buf = self._buf[VAD_WINDOW:]
        return self.prob


# ------------------------------------------------------------------- costs


class CostStats:
    """What a room's Deepgram use cost, logged once a minute (captions.cost) and at the end:
    seconds of audio streamed (what Deepgram bills), seconds sockets were open, opens, closes."""

    def __init__(self, room: str, every_s: float = 60.0, clock_s: Callable[[], float] = time.monotonic) -> None:
        self.room = room
        self.every_s = every_s
        self.clock_s = clock_s
        self.audio_ms = 0
        self.connected_s = 0.0
        self.opens = 0
        self.closes = 0
        self.failures = 0
        self._open_at: dict[int, float] = {}
        self._last = clock_s()

    def opened(self, sid: int) -> None:
        self.opens += 1
        self._open_at[sid] = self.clock_s()

    def closed(self, sid: int) -> None:
        if (t := self._open_at.pop(sid, None)) is not None:
            self.closes += 1
            self.connected_s += self.clock_s() - t

    def sent(self, nbytes: int) -> None:
        self.audio_ms += nbytes // BYTES_PER_MS

    def summary(self) -> str:
        now = self.clock_s()
        connected = self.connected_s + sum(now - t for t in self._open_at.values())
        return (
            f"caption cost {self.room}: deepgram audio {self.audio_ms / 1000:.1f}s, connected {connected:.1f}s, "
            f"opens {self.opens}, closes {self.closes}, open now {len(self._open_at)}, failures {self.failures}"
        )

    def maybe_log(self, force: bool = False) -> str | None:
        if not force and self.clock_s() - self._last < self.every_s:
            return None
        self._last = self.clock_s()
        line = self.summary()
        cost_log.info("%s", line)
        return line


# ------------------------------------------------------------------ socket


class FailoverTracker:
    """When Deepgram is failing: `limit` failures (a connect that fails, or a socket that drops
    unasked) inside `window_s`. The room is then reported paused, so browsers caption on
    device, until a socket works again (agent.py)."""

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

    def success(self) -> bool:
        """A socket worked. True when that ends a failing spell."""
        was = self.tripped
        self._fails.clear()
        self.tripped = False
        return was

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
    """One speaker track's socket, opened and closed by its SpeechGate (open/send/finalize/
    close). Results arrive through `on_event` with wall-clock times."""

    _ids = 0

    def __init__(
        self,
        cfg: Config,
        key: str,
        connect: Connect,
        on_event: OnEvent,
        tracker: FailoverTracker,
        cost: CostStats | None = None,
        on_health: Callable[[bool], None] = lambda ok: None,
    ) -> None:
        self.cfg = cfg
        self.key = key
        self.connect = connect
        self.on_event = on_event
        self.tracker = tracker
        self.cost = cost
        self.on_health = on_health
        self.clock = AudioClock()
        self.ws: Socket | None = None
        self.want_open = False
        self._pending: deque[tuple[bytes, int]] = deque(maxlen=CONNECTING_BUFFER_MS // FRAME_MS)
        self._reader: asyncio.Task[None] | None = None
        self._keepalive: asyncio.Task[None] | None = None
        self._connecting: asyncio.Task[None] | None = None
        self._last_send_s = time.monotonic()
        self._retry_at = 0.0
        self._sid = 0
        self.finals = 0
        self.partials = 0

    # --------------------------------------------------------------- gate actions

    async def open(self) -> None:
        self.want_open = True
        if self.ws is None:
            self._ensure_connecting()

    async def send(self, pcm16: bytes, wall_ms: int) -> None:
        if not self.want_open:
            return
        if self.ws is None:
            # Still connecting (or reconnecting): held, sent in order once the socket opens.
            self._pending.append((pcm16, wall_ms))
            self._ensure_connecting()
            return
        await self._send_now(pcm16, wall_ms)

    async def finalize(self) -> None:
        if self.ws is not None:
            try:
                await self.ws.send_str('{"type":"Finalize"}')
            except Exception as err:
                self._lost(f"finalize failed: {err}")

    async def close(self) -> None:
        """Close the socket (asking Deepgram for its last results first); reusable after."""
        self.want_open = False
        self._pending.clear()
        if self._connecting is not None:
            self._connecting.cancel()
            self._connecting = None
        if self._keepalive is not None:
            self._keepalive.cancel()
            self._keepalive = None
        ws, self.ws = self.ws, None
        if ws is None:
            return
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
        if self.cost is not None:
            self.cost.closed(self._sid)
        log.info("deepgram: stream for %s closed (%d finals, %d partials so far)", self.key, self.finals, self.partials)

    # ---------------------------------------------------------------- the socket

    async def _send_now(self, pcm16: bytes, wall_ms: int) -> None:
        try:
            await self.ws.send_bytes(pcm16)  # type: ignore[union-attr]
        except Exception as err:
            self._pending.append((pcm16, wall_ms))
            self._lost(f"send failed: {err}")
            return
        self.clock.sent(len(pcm16), wall_ms)
        if self.cost is not None:
            self.cost.sent(len(pcm16))
        self._last_send_s = time.monotonic()

    def _ensure_connecting(self) -> None:
        if self._connecting is not None or not self.want_open or time.monotonic() < self._retry_at:
            return
        self._connecting = asyncio.ensure_future(self._connect())

    async def _connect(self) -> None:
        try:
            ws = await self.connect(listen_url(self.cfg), auth_headers(self.cfg))
        except asyncio.CancelledError:
            raise
        except Exception as err:
            # The transport's error (status, reason), never the key.
            log.warning("deepgram: connect for %s failed: %s", self.key, err)
            self._failed()
            return
        finally:
            self._connecting = None
        if not self.want_open:  # closed while connecting
            await _quiet_close(ws)
            return
        self.ws = ws
        if self.tracker.success():
            self.on_health(True)
        DeepgramStream._ids += 1
        self._sid = DeepgramStream._ids
        if self.cost is not None:
            self.cost.opened(self._sid)
        self.clock = AudioClock()  # offsets restart on every socket
        log.info("deepgram: stream open for %s (%s, %s)", self.key, self.cfg.deepgram_model, self.cfg.deepgram_language)
        self._reader = asyncio.ensure_future(self._read(ws))
        self._keepalive = asyncio.ensure_future(self._keep_alive(ws))
        while self._pending and self.ws is ws:
            pcm, wall = self._pending.popleft()
            await self._send_now(pcm, wall)

    def _failed(self) -> None:
        if self.cost is not None:
            self.cost.failures += 1
        if self.tracker.failure():
            self.on_health(False)
        self._retry_at = time.monotonic() + self.tracker.backoff_s()

    def _lost(self, why: str) -> None:
        if not self.want_open:
            return
        log.warning("deepgram: stream for %s lost (%s)", self.key, why)
        self._failed()
        ws, self.ws = self.ws, None
        if self._keepalive is not None:
            self._keepalive.cancel()
            self._keepalive = None
        if self.cost is not None:
            self.cost.closed(self._sid)
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


async def run_actions(stream: DeepgramStream, actions: list[tuple]) -> None:
    """Perform a SpeechGate's actions on its stream, in order."""
    for a in actions:
        if a[0] == "send":
            await stream.send(a[1], a[2])
        elif a[0] == "open":
            await stream.open()
        elif a[0] == "finalize":
            await stream.finalize()
        elif a[0] == "close":
            await stream.close()


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

