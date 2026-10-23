"""faster-whisper, behind a small interface the rest of the agent (and the tests) use.

English only. Live: the English checkpoints (small.en, base.en); after the session:
large-v3-turbo forced to English. No language detection. int8 on CPU through CTranslate2.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import Protocol, Sequence

import numpy as np

ENGLISH = "en"

# Whisper's well-known inventions on noise or silence, which no speaker meant to say.
_HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching.", "thanks for watching!",
    "thank you for watching.", "please subscribe.", "subscribe.", "you", "bye.",
}
_REPEAT = re.compile(r"(\b.{2,30}?\b)(?:[\s,.]*\1){3,}", re.IGNORECASE)


def clean_text(text: str) -> str:
    """Whitespace, bracketed non-speech, runaway repeats and stock hallucinations out."""
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)|♪+", " ", text or "")
    t = t.replace("\ufffd", "")  # a multibyte character cut off by the token limit
    t = re.sub(r"\s+", " ", t).strip()
    t = _REPEAT.sub(r"\1", t)
    if t.lower() in _HALLUCINATIONS:
        return ""
    if not re.search(r"\w", t):
        return ""
    return t


def prompt_for(user_prompt: str = "") -> str | None:
    return user_prompt or None


@dataclass
class Segment:
    start: float  # seconds into the audio passed in
    end: float
    text: str


@dataclass
class Result:
    text: str
    language: str = "en"
    segments: list[Segment] = field(default_factory=list)


class Transcriber(Protocol):
    """`language` and `previous_language` are accepted for the callers' sake; every decode
    is English."""

    name: str

    def transcribe(
        self, audio: np.ndarray, language: str | None = None, previous_language: str | None = None, final: bool = False
    ) -> Result: ...


class WhisperTranscriber:
    """One faster-whisper model, loaded on first use. Thread-safe: calls are serialised."""

    def __init__(self, name: str, cpu_threads: int, download_root: str, prompt: str = "") -> None:
        self.name = name
        self._threads = cpu_threads
        self._root = download_root
        self._prompt = prompt or ""
        self._model = None
        self._lock = threading.Lock()

    def load(self) -> None:
        with self._lock:
            self._load_locked()

    def _load_locked(self) -> None:
        if self._model is None:
            from faster_whisper import WhisperModel  # heavy import, only where a model runs

            self._model = WhisperModel(
                self.name,
                device="cpu",
                compute_type="int8",
                cpu_threads=self._threads,
                num_workers=1,
                download_root=self._root,
            )

    def unload(self) -> None:
        with self._lock:
            self._model = None

    def transcribe(
        self, audio: np.ndarray, language: str | None = None, previous_language: str | None = None, final: bool = False
    ) -> Result:
        with self._lock:
            self._load_locked()
            model = self._model
            if final:
                opts = dict(beam_size=5, vad_filter=True, condition_on_previous_text=True, without_timestamps=False)
            else:
                # Live: greedy, no timestamps, no carried context — speed and no runaway loops.
                opts = dict(
                    beam_size=1, best_of=1, vad_filter=False, condition_on_previous_text=False,
                    without_timestamps=True, max_new_tokens=224, no_repeat_ngram_size=3,
                )
            segs, _info = model.transcribe(
                audio, language=ENGLISH, task="transcribe", temperature=0.0,
                initial_prompt=prompt_for(self._prompt), **opts,
            )
            out: list[Segment] = []
            for s in segs:
                if getattr(s, "no_speech_prob", 0.0) > 0.6 and getattr(s, "avg_logprob", 0.0) < -1.0:
                    continue
                text = clean_text(s.text)
                if text:
                    out.append(Segment(start=float(s.start), end=float(s.end), text=text))
            return Result(text=clean_text(" ".join(s.text for s in out)), language=ENGLISH, segments=out)


def segments_text(segments: Sequence[Segment]) -> str:
    return " ".join(s.text for s in segments).strip()
