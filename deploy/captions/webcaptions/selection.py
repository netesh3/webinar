"""Who gets transcribed.

Only the ACTIVE speakers, and at most N of them at once, so the cost follows how many people
are talking rather than how many are in the room: a 50-person meeting where two people talk
costs what a 5-person one does. LiveKit's own active-speaker updates (computed on the SFU,
from audio levels it already has) decide who is talking; this module only decides which of
them hold the N transcription slots.

Rules:
  * A free slot goes to the loudest active speaker who does not have one.
  * A speaker keeps their slot for `linger_s` after LiveKit stops listing them, so a pause
    for breath does not cut the end of their sentence off.
  * When every slot is taken and someone new starts talking, the slot of whoever has been
    silent longest (lingering, not active) is given up. A slot held by someone who is still
    talking is never taken away.
  * Lowering the limit (the CPU guard does, to 1) keeps the most recently active speakers.
"""

from __future__ import annotations

import time
from typing import Callable, Iterable


class SpeakerSelector:
    def __init__(
        self,
        max_speakers: int = 2,
        linger_s: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_speakers < 1:
            raise ValueError("max_speakers must be >= 1")
        self._max = max_speakers
        self._linger = linger_s
        self._clock = clock
        self._selected: dict[str, float] = {}  # identity -> last time it was active
        self._active: list[str] = []

    @property
    def max_speakers(self) -> int:
        return self._max

    @max_speakers.setter
    def max_speakers(self, value: int) -> None:
        self._max = max(1, int(value))
        self._trim(set(self._active))

    @property
    def selected(self) -> set[str]:
        return set(self._selected)

    def update(self, active: Iterable[str], now: float | None = None) -> set[str]:
        """Feed the current active-speaker list, loudest first. Returns the selected set.

        Also call it on a timer with the last list, so lingering slots expire on time.
        """
        now = self._clock() if now is None else now
        ordered: list[str] = []
        for identity in active:
            if identity and identity not in ordered:
                ordered.append(identity)
        self._active = ordered
        active_set = set(ordered)

        for identity in ordered:
            if identity in self._selected:
                self._selected[identity] = now

        # Expire lingering slots.
        for identity, last in list(self._selected.items()):
            if identity not in active_set and now - last >= self._linger:
                del self._selected[identity]

        for identity in ordered:
            if identity in self._selected:
                continue
            if len(self._selected) < self._max:
                self._selected[identity] = now
                continue
            # Full: give up the slot of whoever has been quiet longest, if anyone is quiet.
            quiet = [(last, i) for i, last in self._selected.items() if i not in active_set]
            if not quiet:
                break  # everyone selected is talking; the newcomer waits
            _, evict = min(quiet)
            del self._selected[evict]
            self._selected[identity] = now

        self._trim(active_set)
        return self.selected

    def remove(self, identity: str) -> None:
        """The participant left, or unpublished their microphone."""
        self._selected.pop(identity, None)
        self._active = [i for i in self._active if i != identity]

    def _trim(self, active_set: set[str]) -> None:
        if len(self._selected) <= self._max:
            return
        # Talking beats lingering, then most recent first.
        ranked = sorted(
            self._selected.items(),
            key=lambda kv: (kv[0] in active_set, kv[1]),
            reverse=True,
        )
        self._selected = dict(ranked[: self._max])


# Screen-share audio (a video or a clip played into a share) is transcribed whenever it is
# published: it is content everyone is listening to, there is rarely more than one, and the
# silence gate and the CPU guard bound it like a microphone. Microphones follow the
# active-speaker selection above. Each source gets its own pipeline, keyed apart, so a
# presenter's mic and their share's audio are never one stream.
SHARE_SUFFIX = "#share"


def pipeline_key(identity: str, is_share: bool) -> str:
    return identity + SHARE_SUFFIX if is_share else identity


def wants_audio(identity: str, is_share: bool, chosen) -> bool:
    return True if is_share else identity in chosen


def main_source(active: Iterable[str], speaking: Iterable[str]) -> str | None:
    """The one pipeline key that gets interim captions: the source the room is listening to.

    `speaking` is the pipeline keys mid-line right now. Share audio wins (a video played
    into a share is what everyone is hearing); then the loudest active speaker, in
    LiveKit's order; then, while the active list lags behind, whoever is mid-line."""
    now = sorted(set(speaking))
    if not now:
        return None
    for key in now:
        if key.endswith(SHARE_SUFFIX):
            return key
    for identity in active:
        if identity in now:
            return identity
    return now[0]


# Why every microphone is subscribed, not only the selected ones: LiveKit sends a participant
# active-speaker updates ONLY for the participants it is subscribed to (livekit-server
# ParticipantImpl.SendSpeakerUpdate filters them with IsSubscribedTo). An agent that
# subscribed to the selection alone never heard that anyone was speaking, so never selected
# anyone, so never subscribed: nobody was captioned. So the agent subscribes to every
# person's audio (on the same host that is an Opus decode and one RMS per frame), and the
# selection decides whose LINES reach the model, which is the expensive part.
def wants_key(key: str, chosen) -> bool:
    """Whether the pipeline `key` (see pipeline_key) is to be transcribed now."""
    return key.endswith(SHARE_SUFFIX) or key in chosen


class LineGate:
    """Per source: whether a finished line goes to the model.

    LiveKit names an active speaker a few hundred ms after they start, so a line usually
    opens before its speaker is selected. A line is kept when its source is selected when it
    ends OR was at any point while it was open; a line nobody selected is dropped."""

    def __init__(self) -> None:
        self._held = False

    def note(self, selected: bool, in_speech: bool) -> None:
        if selected and in_speech:
            self._held = True

    def take(self, selected: bool) -> bool:
        keep = selected or self._held
        self._held = False
        return keep


class FrameWatch:
    """Diagnostics: subscribed sources that have sent no audio frame for `quiet_s` while
    their track is unmuted (a subscription that never delivers, a stalled stream). Each is
    reported once per quiet spell; a frame re-arms it."""

    def __init__(self, quiet_s: float = 60.0) -> None:
        self.quiet_s = quiet_s
        self._last: dict[str, float] = {}
        self._frames: dict[str, int] = {}
        self._warned: set[str] = set()

    def start(self, key: str, now: float) -> None:
        self._last[key] = now
        self._frames[key] = 0
        self._warned.discard(key)

    def frame(self, key: str, now: float) -> bool:
        """Records a frame; True for the source's first one (worth one log line)."""
        self._last[key] = now
        self._warned.discard(key)
        n = self._frames.get(key, 0)
        self._frames[key] = n + 1
        return n == 0

    def stop(self, key: str) -> None:
        self._last.pop(key, None)
        self._frames.pop(key, None)
        self._warned.discard(key)

    def frames(self, key: str) -> int:
        return self._frames.get(key, 0)

    def due(self, now: float, muted: Callable[[str], bool] = lambda _k: False) -> list[str]:
        out = []
        for key, last in self._last.items():
            if key in self._warned or now - last < self.quiet_s:
                continue
            if muted(key):
                self._last[key] = now  # muted time is not quiet time
                continue
            self._warned.add(key)
            out.append(key)
        return sorted(out)
