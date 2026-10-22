"""Configuration, from the environment. Every knob is documented in README.md."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

LANGUAGES = ("auto", "en", "hi")
SCRIPTS = ("roman", "native")


class ConfigError(ValueError):
    pass


def _bool(raw: str | None, default: bool) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be a number, got {raw!r}") from exc


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class Config:
    # Where the finished lines go, and the secret the API checks (CAPTIONS_SECRET there too).
    api_url: str
    secret: str
    # The LiveKit agent name the API dispatches (CAPTIONS_AGENT_NAME on both sides).
    agent_name: str = "webinar-captions"

    # Models. Multilingual on purpose: the .en checkpoints cannot do Hindi.
    model: str = "small"
    fallback_model: str = "base"
    final_model: str = "large-v3-turbo"
    final_enabled: bool = True
    model_dir: str = "/models"

    # auto = pick English or Hindi per line; en / hi force one.
    language: str = "auto"
    # roman = Devanagari is transliterated to Latin (Hinglish as people type it); native keeps
    # Devanagari. English words are never touched either way.
    script: str = "roman"
    # Optional decoder prompt, e.g. a few product names, to bias spelling.
    prompt: str = ""

    max_speakers: int = 2
    # Seconds a speaker keeps their slot after LiveKit stops calling them active, so the
    # tail of a sentence is not cut off when they pause for breath.
    speaker_linger_s: float = 3.0
    max_rooms: int = 2

    # The docker CPU cap, also used to size the decoder's threads.
    cpus: float = 2.0

    # Energy gate (RMS of 16 kHz float audio, 0..1). Below it a frame is silence and costs
    # nothing beyond the RMS itself.
    energy_gate: float = 0.012
    silence_end_s: float = 0.6
    max_utterance_s: float = 6.0

    # CPU guard thresholds (percent of the whole host) and how long they must hold.
    cpu_high: float = 85.0
    cpu_critical: float = 95.0
    cpu_low: float = 70.0
    cpu_high_for_s: float = 10.0
    cpu_low_for_s: float = 20.0
    cpu_sample_s: float = 2.0

    spool_dir: str = "/var/lib/captions/spool"
    spool_max_mb: int = 4096
    health_port: int = 8091

    @property
    def cpu_threads(self) -> int:
        return max(1, int(self.cpus))

    @property
    def whisper_language(self) -> str | None:
        """The fixed language to decode in, or None for per-line detection."""
        return None if self.language == "auto" else self.language

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        api_url = env.get("CAPTIONS_API_URL", "").strip().rstrip("/")
        secret = env.get("CAPTIONS_SECRET", "").strip()
        if not api_url:
            raise ConfigError("CAPTIONS_API_URL is required (e.g. https://webinarliv.com)")
        if len(secret) < 32:
            raise ConfigError("CAPTIONS_SECRET must be set, at least 32 characters, same as the API's")
        language = env.get("CAPTIONS_LANGUAGE", "auto").strip().lower() or "auto"
        if language not in LANGUAGES:
            raise ConfigError(f"CAPTIONS_LANGUAGE must be one of {LANGUAGES}, got {language!r}")
        script = env.get("CAPTIONS_SCRIPT", "roman").strip().lower() or "roman"
        if script not in SCRIPTS:
            raise ConfigError(f"CAPTIONS_SCRIPT must be one of {SCRIPTS}, got {script!r}")
        cfg = cls(
            api_url=api_url,
            secret=secret,
            agent_name=env.get("CAPTIONS_AGENT_NAME", "").strip() or "webinar-captions",
            model=env.get("CAPTIONS_MODEL", "").strip() or "small",
            fallback_model=env.get("CAPTIONS_FALLBACK_MODEL", "").strip() or "base",
            final_model=env.get("CAPTIONS_FINAL_MODEL", "").strip() or "large-v3-turbo",
            final_enabled=_bool(env.get("CAPTIONS_FINAL_ENABLED"), True),
            model_dir=env.get("CAPTIONS_MODEL_DIR", "").strip() or "/models",
            language=language,
            script=script,
            prompt=env.get("CAPTIONS_PROMPT", "").strip(),
            max_speakers=_int(env, "CAPTIONS_MAX_SPEAKERS", 2),
            speaker_linger_s=_float(env, "CAPTIONS_SPEAKER_LINGER_S", 3.0),
            max_rooms=_int(env, "CAPTIONS_MAX_ROOMS", 2),
            cpus=_float(env, "CAPTIONS_CPUS", 2.0),
            energy_gate=_float(env, "CAPTIONS_ENERGY_GATE", 0.012),
            silence_end_s=_float(env, "CAPTIONS_SILENCE_END_S", 0.6),
            max_utterance_s=_float(env, "CAPTIONS_MAX_UTTERANCE_S", 6.0),
            cpu_high=_float(env, "CAPTIONS_CPU_HIGH", 85.0),
            cpu_critical=_float(env, "CAPTIONS_CPU_CRITICAL", 95.0),
            cpu_low=_float(env, "CAPTIONS_CPU_LOW", 70.0),
            cpu_high_for_s=_float(env, "CAPTIONS_CPU_HIGH_FOR_S", 10.0),
            cpu_low_for_s=_float(env, "CAPTIONS_CPU_LOW_FOR_S", 20.0),
            cpu_sample_s=_float(env, "CAPTIONS_CPU_SAMPLE_S", 2.0),
            spool_dir=env.get("CAPTIONS_SPOOL_DIR", "").strip() or "/var/lib/captions/spool",
            spool_max_mb=_int(env, "CAPTIONS_SPOOL_MAX_MB", 4096),
            health_port=_int(env, "CAPTIONS_HEALTH_PORT", 8091),
        )
        if cfg.max_speakers < 1:
            raise ConfigError("CAPTIONS_MAX_SPEAKERS must be >= 1")
        if not (cfg.cpu_low < cfg.cpu_high <= cfg.cpu_critical):
            raise ConfigError("need CAPTIONS_CPU_LOW < CAPTIONS_CPU_HIGH <= CAPTIONS_CPU_CRITICAL")
        return cfg
