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
