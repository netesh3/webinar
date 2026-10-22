"""Energy gate and utterance cutting, per speaker.

Audio arrives as 10-20 ms frames of 16 kHz mono. Silence is recognised by RMS alone — one
numpy reduction per frame — and never reaches the model, which is what makes a quiet room
free. Speech is collected into an utterance that is closed after `silence_end_s` of quiet,
or at `max_utterance_s` so a monologue still produces a caption every few seconds.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16_000


@dataclass
class Utterance:
    audio: np.ndarray  # float32, 16 kHz mono, -1..1
    started_at_ms: int  # wall clock, Unix ms, of the first sample
    voiced_s: float

    @property
    def duration_s(self) -> float:
        return len(self.audio) / SAMPLE_RATE


def rms(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float32))))


def pcm16_to_float(data: bytes | memoryview | np.ndarray) -> np.ndarray:
    arr = data if isinstance(data, np.ndarray) else np.frombuffer(data, dtype=np.int16)
    return arr.astype(np.float32) / 32768.0


class Segmenter:
    def __init__(
        self,
        energy_gate: float = 0.012,
        silence_end_s: float = 0.6,
        max_utterance_s: float = 6.0,
        min_voiced_s: float = 0.3,
        pre_roll_s: float = 0.2,
    ) -> None:
        self.gate = energy_gate
        self.silence_end_s = silence_end_s
        self.max_utterance_s = max_utterance_s
        self.min_voiced_s = min_voiced_s
        self._pre_roll_n = int(pre_roll_s * SAMPLE_RATE)
        self._pre: deque[np.ndarray] = deque()
        self._pre_len = 0
        self._chunks: list[np.ndarray] = []
        self._len = 0
        self._voiced = 0
        self._silence = 0
        self._start_ms = 0

    @property
    def in_speech(self) -> bool:
        return bool(self._chunks)

    def push(self, frame: np.ndarray, at_ms: int) -> list[Utterance]:
        """One frame, received at wall-clock `at_ms` (the time of its LAST sample)."""
        out: list[Utterance] = []
        n = len(frame)
        if n == 0:
            return out
        loud = rms(frame) >= self.gate
        if not self._chunks:
            if not loud:
                self._remember(frame)
                return out
            # Speech starts: open with the pre-roll so the first consonant is not clipped.
            pre = list(self._pre)
            pre_n = self._pre_len
            self._pre.clear()
            self._pre_len = 0
            self._chunks = pre + [frame]
            self._len = pre_n + n
            self._voiced = n
            self._silence = 0
            self._start_ms = at_ms - int(1000 * (pre_n + n) / SAMPLE_RATE)
        else:
            self._chunks.append(frame)
            self._len += n
            if loud:
                self._voiced += n
                self._silence = 0
            else:
                self._silence += n

        if self._silence >= self.silence_end_s * SAMPLE_RATE:
            u = self._close(trim_tail=self._silence)
            if u:
                out.append(u)
        elif self._len >= self.max_utterance_s * SAMPLE_RATE:
            u = self._close(trim_tail=0)
            if u:
                out.append(u)
        return out

    def flush(self) -> list[Utterance]:
        """The speaker went away mid-sentence: close whatever is open."""
        if not self._chunks:
            return []
        u = self._close(trim_tail=self._silence)
        return [u] if u else []

    def _remember(self, frame: np.ndarray) -> None:
        self._pre.append(frame)
        self._pre_len += len(frame)
        while self._pre and self._pre_len - len(self._pre[0]) >= self._pre_roll_n:
            self._pre_len -= len(self._pre.popleft())

    def _close(self, trim_tail: int) -> Utterance | None:
        audio = np.concatenate(self._chunks) if self._chunks else np.zeros(0, np.float32)
        voiced = self._voiced
        start = self._start_ms
        self._chunks, self._len, self._voiced, self._silence = [], 0, 0, 0
        # Keep a little of the trailing quiet (Whisper likes a pause at the end), not all.
        keep_tail = min(trim_tail, int(0.3 * SAMPLE_RATE))
        if trim_tail > keep_tail:
            audio = audio[: len(audio) - (trim_tail - keep_tail)]
        if voiced < self.min_voiced_s * SAMPLE_RATE:
            return None
        return Utterance(audio=audio.astype(np.float32, copy=False), started_at_ms=start, voiced_s=voiced / SAMPLE_RATE)
