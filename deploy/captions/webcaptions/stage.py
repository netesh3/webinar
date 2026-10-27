"""The video box worker's per-room logic (CAPTIONS_PROVIDER=deepgram), without LiveKit:
who is transcribed, one speaker's VAD → gate → socket, and the room's transcript.

stage_agent.py wires these to the room; tests drive them with fakes.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from .poster import TranscriptLine
from .provider import DeepgramStream, SpeechGate, run_actions
from .segmenter import pcm16_to_float

log = logging.getLogger("captions.stage")

STAGE_ROLES = ("host", "panelist")  # api/types: a co-host and a promoted attendee are panelists


def is_stage(metadata: str | None, can_publish: bool) -> bool:
    """Whose microphone is transcribed: the host and panelists (co-hosts and promoted
    attendees are panelists, api/internal/lk metadataFor), never an attendee. With no role in
    the metadata, whoever the room lets publish."""
    try:
        meta = json.loads(metadata) if metadata else {}
    except ValueError:
        meta = {}
    role = meta.get("role") if isinstance(meta, dict) else None
    if isinstance(role, str) and role:
        return role in STAGE_ROLES
    return bool(can_publish)


class Vad(Protocol):
    def push(self, samples: Any) -> float | None: ...


class SpeakerTrack:
    """One stage microphone: each 10 ms frame goes through the VAD, the gate decides, the
    stream does it. Muted: the socket is closed at once and nothing is scored or sent."""

    def __init__(self, key: str, vad: Vad, gate: SpeechGate, stream: DeepgramStream) -> None:
        self.key = key
        self.vad = vad
        self.gate = gate
        self.stream = stream

    async def frame(self, pcm16: bytes, wall_ms: int, muted: bool = False) -> None:
        if muted:
            await self.mute()
            return
        prob = self.vad.push(pcm16_to_float(pcm16))
        await run_actions(self.stream, self.gate.push(pcm16, wall_ms, prob))

    async def mute(self) -> None:
        await run_actions(self.stream, self.gate.force_close())

    async def stop(self) -> None:
        """Unpublished, unsubscribed, left, or the room ended: the socket goes now."""
        await self.mute()
        await self.stream.close()


class RoomTranscript:
    """Every final Deepgram sent for the room, which with deepgram IS the session transcript:
    posted to /api/internal/transcripts when the room ends (no audio kept, no after-session
    pass). The same line twice (a reconnect replaying audio) is kept once."""

    def __init__(self) -> None:
        self.lines: list[TranscriptLine] = []
        self._seen: set[tuple[str, int, str]] = set()

    def add(self, identity: str, name: str, start_ms: int, end_ms: int, text: str) -> None:
        text = " ".join((text or "").split())
        if not text:
            return
        k = (identity, int(start_ms), text)
        if k in self._seen:
            return
        self._seen.add(k)
        self.lines.append(TranscriptLine(identity, name, int(start_ms), int(max(end_ms, start_ms)), text))

    def ordered(self) -> list[TranscriptLine]:
        return sorted(self.lines, key=lambda l: (l.start_ms, l.identity))


def post_transcript(
    api: Any, room: str, model: str, transcript: RoomTranscript, skip: bool, language: str | None = None
) -> int | None:
    """At the room's end: the finals as the session transcript, posted even when empty (the
    AI recap waits for a transcript stored after the end, and starts the moment this lands).
    Not for a load test ("final":"skip"), whose transcript nobody reads."""
    if skip:
        log.info("captions: %s is a load test; no transcript posted (%d lines)", room, len(transcript.lines))
        return None
    lines = transcript.ordered()
    status = api.transcript(room, model, lines, language) if language else api.transcript(room, model, lines)
    log.info("session transcript for %s: %d lines from %s, API %d", room, len(lines), model, status)
    return status
