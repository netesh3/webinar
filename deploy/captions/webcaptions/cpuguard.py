"""Video always wins: the in-process CPU guard.

The container already runs at low priority (nice, cpu_shares) under a hard docker `cpus`
cap. This is the third layer: it watches the WHOLE HOST's CPU (/proc/stat is not namespaced,
so inside the container it still reads the box) and backs captions off before the egress
mix or the SFU feel it.

    NORMAL    live model, up to CAPTIONS_MAX_SPEAKERS speakers
    DEGRADED  host above `high` (85%) for `high_for` (10s): fallback model (small -> base),
              one speaker, stale windows skipped
    PAUSED    host above `critical` (95%) on any sample: no live transcription at all; the
              API is told, and the browsers fall back to their own captions

Recovery is one step at a time (PAUSED -> DEGRADED -> NORMAL), each after the host has been
below `low` (70%) for `low_for` (20s), so a box hovering near the line does not flap. Audio
is still written to disk while paused (a file append, not a decode), so the after-session
transcript has no hole in it.

The guard never touches the egress process: it only changes what this process does.
"""

from __future__ import annotations

import enum
import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable


class Level(enum.IntEnum):
    NORMAL = 0
    DEGRADED = 1
    PAUSED = 2


class CpuGuard:
    def __init__(
        self,
        high: float = 85.0,
        critical: float = 95.0,
        low: float = 70.0,
        high_for: float = 10.0,
        low_for: float = 20.0,
    ) -> None:
        self.high, self.critical, self.low = high, critical, low
        self.high_for, self.low_for = high_for, low_for
        self.level = Level.NORMAL
        self._above_since: float | None = None
        self._below_since: float | None = None

    def observe(self, usage: float, now: float) -> Level:
        """One host CPU sample (percent busy, 0-100) taken at `now` (seconds)."""
        if usage > self.high:
            if self._above_since is None:
                self._above_since = now
        else:
            self._above_since = None

        if usage < self.low:
            if self._below_since is None:
                self._below_since = now
        else:
            self._below_since = None

        if usage > self.critical:
            self.level = Level.PAUSED
            return self.level

        if (
            self.level < Level.DEGRADED
            and self._above_since is not None
            and now - self._above_since >= self.high_for
        ):
            self.level = Level.DEGRADED
            return self.level

        if (
            self.level > Level.NORMAL
            and self._below_since is not None
            and now - self._below_since >= self.low_for
        ):
            self.level = Level(self.level - 1)
            # The next step down needs its own full quiet period.
            self._below_since = now
        return self.level


@dataclass
class CpuTimes:
    busy: int
    total: int


def parse_proc_stat(text: str) -> CpuTimes | None:
    """The aggregate `cpu` line of /proc/stat, as busy and total jiffies."""
    for line in text.splitlines():
        if line.startswith("cpu "):
            fields = [int(x) for x in line.split()[1:]]
            # user nice system idle iowait irq softirq steal [guest guest_nice]
            # guest time is already counted in user/nice, so it is left out of the total.
            fields = fields[:8] + [0] * (8 - len(fields[:8]))
            idle = fields[3] + fields[4]
            total = sum(fields)
            return CpuTimes(busy=total - idle, total=total)
    return None


class HostCpuSampler:
    """Percent of the host's CPU busy since the previous call. None where /proc is absent."""

    def __init__(self, path: str = "/proc/stat") -> None:
        self._path = path
        self._last: CpuTimes | None = None

    def read(self) -> CpuTimes | None:
        try:
            with open(self._path, encoding="ascii") as f:
                return parse_proc_stat(f.read())
        except OSError:
            return None

    def sample(self) -> float | None:
        cur = self.read()
        if cur is None:
            return None
        prev, self._last = self._last, cur
        if prev is None:
            return None
        return usage_between(prev, cur)


def usage_between(prev: CpuTimes, cur: CpuTimes) -> float | None:
    total = cur.total - prev.total
    if total <= 0:
        return None
    busy = max(0, cur.busy - prev.busy)
    return 100.0 * busy / total


class GuardMonitor:
    """Samples the host every `interval` seconds on a daemon thread and keeps `level`.

    `on_change(old, new)` runs on the monitor thread; callers on an event loop hand it over
    with loop.call_soon_threadsafe. Where /proc/stat cannot be read (a laptop) the level
    stays NORMAL: the docker cap still applies.
    """

    def __init__(self, guard: CpuGuard, interval: float = 2.0, sampler: HostCpuSampler | None = None,
                 on_change: Callable[[Level, Level], None] | None = None) -> None:
        self.guard = guard
        self.interval = interval
        self.sampler = sampler or HostCpuSampler()
        self.on_change = on_change
        self.last_usage: float | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def level(self) -> Level:
        return self.guard.level

    def start(self) -> "GuardMonitor":
        self.sampler.sample()  # prime the first delta
        self._thread = threading.Thread(target=self._run, name="cpu-guard", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def wait_until_normal(self, stop: threading.Event | None = None) -> bool:
        """Blocks while the host is busy. False if `stop` was set while waiting."""
        while self.guard.level != Level.NORMAL:
            if stop is not None and stop.wait(self.interval):
                return False
            if stop is None:
                time.sleep(self.interval)
        return True

    def tick(self, now: float | None = None) -> Level:
        usage = self.sampler.sample()
        if usage is None:
            return self.guard.level
        self.last_usage = usage
        old = self.guard.level
        new = self.guard.observe(usage, time.monotonic() if now is None else now)
        if new != old and self.on_change is not None:
            self.on_change(old, new)
        return new

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.tick()
            except Exception:  # never let the guard thread die silently mid-session
                logging.getLogger("captions.cpuguard").exception("cpu guard sample failed")
