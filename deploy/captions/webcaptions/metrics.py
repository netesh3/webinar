"""Caption latency, measured where it happens and logged once a minute per room.

    caption latency webinar_x: finals 12, partials 30 | e2e p50 1210 p90 1650 |
        queue p50 3 p90 420 | decode p50 820 p90 1100 | partial p50 260 p90 330 |
        post p50 95 p90 160 | api_lag p50 1330 p90 1800 (ms)

  e2e      end of the speech in a line -> its packet handed to the SFU (what a viewer in the
           LiveKit room waits, give or take ~50 ms of SFU delivery)
  queue    end of the speech -> its decode starting (another line, or a partial, ahead)
  decode   one final decode; `partial` one interim decode
  post     the POST to the API, round trip (off the display path when published directly)
  api_lag  end of the speech -> the API answered (what an edge viewer's line waits before
           their player's hold; also the whole path when the agent cannot publish itself)

The API logs its own side (age at relay) in handleInternalCaption.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from typing import Callable

log = logging.getLogger("captions.latency")

ORDER = ("e2e", "queue", "decode", "partial", "post", "api_lag")


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


class LatencyStats:
    def __init__(self, room: str, every_s: float = 60.0, clock_s: Callable[[], float] = time.monotonic) -> None:
        self.room = room
        self.every_s = every_s
        self._clock = clock_s
        self._lock = threading.Lock()
        self._values: dict[str, list[float]] = defaultdict(list)
        self.counts: dict[str, int] = defaultdict(int)
        self._since = self._clock()

    def record(self, name: str, ms: float) -> None:
        with self._lock:
            self._values[name].append(float(ms))

    def count(self, name: str) -> None:
        with self._lock:
            self.counts[name] += 1

    def values(self, name: str) -> list[float]:
        with self._lock:
            return list(self._values.get(name, []))

    def summary(self) -> str:
        with self._lock:
            parts = [f"finals {self.counts.get('finals', 0)}, partials {self.counts.get('partials', 0)}"]
            for name in ORDER:
                v = self._values.get(name)
                if v:
                    parts.append(f"{name} p50 {percentile(v, 0.5):.0f} p90 {percentile(v, 0.9):.0f}")
            return " | ".join(parts) + " (ms)"

    def maybe_log(self) -> str | None:
        """Logs and resets once `every_s` has passed, if anything was measured."""
        now = self._clock()
        if now - self._since < self.every_s:
            return None
        line = self.summary()
        with self._lock:
            had = any(self._values.values()) or any(self.counts.values())
            self._values.clear()
            self.counts.clear()
            self._since = now
        if not had:
            return None
        log.info("caption latency %s: %s", self.room, line)
        return line
