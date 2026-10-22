"""faster-whisper, behind a small interface the rest of the agent (and the tests) use.

Multilingual checkpoints only (small / base live, large-v3-turbo after the session): the
.en models cannot transcribe Hindi at all. int8 on CPU through CTranslate2.

Language, when CAPTIONS_LANGUAGE=auto, is chosen per utterance between English and Hindi
ONLY. Whisper's own detector, given a few seconds of Hindi, regularly answers Urdu (same
spoken language, Arabic script) or Punjabi; letting it would put Nastaliq on the screen.
Urdu's probability is counted as Hindi's. A speaker's previous choice is kept unless the
other language is clearly ahead, so code-mixed Hinglish does not flip script every line.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import Iterable, Protocol, Sequence

import numpy as np

# How far ahead the other language must be to switch a speaker away from their last one.
STICKY_MARGIN = 0.2


def choose_language(probs: Iterable[tuple[str, float]], previous: str | None = None) -> str:
    """English or Hindi, from Whisper's language probabilities."""
    en = hi = 0.0
    for lang, p in probs:
        if lang == "en":
            en += p
        elif lang in ("hi", "ur"):
            hi += p
    if en == 0.0 and hi == 0.0:
        return previous or "en"
    pick = "hi" if hi > en else "en"
    if previous in ("en", "hi") and pick != previous:
        lead = abs(hi - en) / max(hi + en, 1e-9)
        if lead < STICKY_MARGIN:
            return previous
    return pick


"""Whisper decoding Hindi will often write it in Urdu (Arabic) script even with language=hi:
measured on a synthetic Hindi clip, `base` gave Nastaliq every time and `small` sometimes. A
Devanagari sentence as the decoder prompt fixes it ("नमस्ते डोस्तों आज हम ... बात करेंगे"
from small with it), so Hindi decoding always starts from one. A line that still comes out
in Arabic script is dropped rather than shown, since no audience here reads it."""
HINDI_PROMPT = "नमस्ते। यह बातचीत हिंदी और अंग्रेज़ी में है।"

_ARABIC = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")


def prompt_for(language: str | None, user_prompt: str = "") -> str | None:
    parts = [HINDI_PROMPT] if language == "hi" else []
    if user_prompt:
        parts.append(user_prompt)
    return " ".join(parts) or None


def has_arabic_script(text: str) -> bool:
    return bool(_ARABIC.search(text or ""))


# Whisper's well-known inventions on noise or silence, which no speaker meant to say.
_HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching.", "thanks for watching!",
    "thank you for watching.", "please subscribe.", "subscribe.", "you", "bye.",
    "धन्यवाद।", "धन्यवाद", "सब्सक्राइब करें", "शुक्रिया।",
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


@dataclass
class Segment:
    start: float  # seconds into the audio passed in
    end: float
    text: str


@dataclass
class Result:
    text: str
    language: str
    segments: list[Segment] = field(default_factory=list)


class Transcriber(Protocol):
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
            lang = language
            if lang is None:
                _, _, probs = model.detect_language(audio=audio, language_detection_segments=1)
                lang = choose_language(probs, previous_language)
            if final:
                opts = dict(beam_size=5, vad_filter=True, condition_on_previous_text=True, without_timestamps=False)
            else:
                # Live: greedy, no timestamps, no carried context — speed and no runaway loops.
                opts = dict(
                    beam_size=1, best_of=1, vad_filter=False, condition_on_previous_text=False,
                    # Devanagari costs about a token per byte, so ~6 s of Hindi needs ~200.
                    without_timestamps=True, max_new_tokens=224, no_repeat_ngram_size=3,
                )
            segs, _info = model.transcribe(
                audio, language=lang, task="transcribe", temperature=0.0,
                initial_prompt=prompt_for(lang, self._prompt), **opts,
            )
            out: list[Segment] = []
            for s in segs:
                if getattr(s, "no_speech_prob", 0.0) > 0.6 and getattr(s, "avg_logprob", 0.0) < -1.0:
                    continue
                text = clean_text(s.text)
                if has_arabic_script(text):
                    continue  # Hindi in Urdu script: see HINDI_PROMPT
                if text:
                    out.append(Segment(start=float(s.start), end=float(s.end), text=text))
            return Result(text=clean_text(" ".join(s.text for s in out)), language=lang, segments=out)


def segments_text(segments: Sequence[Segment]) -> str:
    return " ".join(s.text for s in segments).strip()
