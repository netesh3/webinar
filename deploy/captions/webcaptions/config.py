"""Configuration, from the environment. Every knob is documented in README.md."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# English only. CAPTIONS_LANGUAGE is still read so an old .env with `en` keeps working;
# anything else is refused rather than silently captioned in English.
LANGUAGES = ("en",)


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

    # Models. English-only checkpoints live (more accurate than the multilingual ones of
    # the same size on English, and nothing to detect); the after-session pass is the
    # multilingual large-v3-turbo forced to English (see README "Models").
    model: str = "small.en"
    fallback_model: str = "base.en"
    final_model: str = "large-v3-turbo"
    final_enabled: bool = True
    model_dir: str = "/models"

    # Always English; kept as a field for the log line and the decoder calls.
    language: str = "en"
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
    # When a line is cut. 0.45 s of quiet ends a sentence (was 0.6): conversational pauses
    # inside a sentence are mostly under 0.4 s, so this still rarely splits one, and every
    # line reaches the screen 150 ms sooner. Past soft_utterance_s a breath (soft_silence_s)
    # is enough, and max_utterance_s (was 6) is the hard cap for someone who never pauses.
    silence_end_s: float = 0.45
    max_utterance_s: float = 5.0
    soft_utterance_s: float = 3.0
    soft_silence_s: float = 0.25

    # Interim captions: while the main speaker is mid-line, the line so far is decoded every
    # partial_interval_s with partial_model (default: the fallback model, already loaded and
    # several times cheaper than the live one) and shown until the final replaces it. Only
    # in NORMAL, only for one speaker, only while captions are shown; never stored.
    partials: bool = True
    partial_interval_s: float = 1.0
    partial_model: str = ""

    # Publish each line straight to the room (the agent is in it, next to the SFU) instead
    # of waiting on the API's relay; the API still gets every final, off the display path.
    direct_publish: bool = True

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
    def partial_model_name(self) -> str:
        return self.partial_model or self.fallback_model

    @property
    def whisper_language(self) -> str:
        """The language every pass decodes in. Never None: there is no detection."""
        return self.language

    @property
    def script(self) -> str:
        """Retired (captions are English, nothing to transliterate). Still read by the
        finalizer through roman.apply_script, which is now a pass-through."""
        return "native"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        api_url = env.get("CAPTIONS_API_URL", "").strip().rstrip("/")
        secret = env.get("CAPTIONS_SECRET", "").strip()
        if not api_url:
            raise ConfigError("CAPTIONS_API_URL is required (e.g. https://webinarliv.com)")
        if len(secret) < 32:
            raise ConfigError("CAPTIONS_SECRET must be set, at least 32 characters, same as the API's")
        language = env.get("CAPTIONS_LANGUAGE", "en").strip().lower() or "en"
        if language not in LANGUAGES:
            raise ConfigError(f"CAPTIONS_LANGUAGE must be one of {LANGUAGES} (captions are English only), got {language!r}")
        cfg = cls(
            api_url=api_url,
            secret=secret,
            agent_name=env.get("CAPTIONS_AGENT_NAME", "").strip() or "webinar-captions",
            model=env.get("CAPTIONS_MODEL", "").strip() or "small.en",
            fallback_model=env.get("CAPTIONS_FALLBACK_MODEL", "").strip() or "base.en",
            final_model=env.get("CAPTIONS_FINAL_MODEL", "").strip() or "large-v3-turbo",
            final_enabled=_bool(env.get("CAPTIONS_FINAL_ENABLED"), True),
            model_dir=env.get("CAPTIONS_MODEL_DIR", "").strip() or "/models",
            language=language,
            prompt=env.get("CAPTIONS_PROMPT", "").strip(),
            max_speakers=_int(env, "CAPTIONS_MAX_SPEAKERS", 2),
            speaker_linger_s=_float(env, "CAPTIONS_SPEAKER_LINGER_S", 3.0),
            max_rooms=_int(env, "CAPTIONS_MAX_ROOMS", 2),
            cpus=_float(env, "CAPTIONS_CPUS", 2.0),
            energy_gate=_float(env, "CAPTIONS_ENERGY_GATE", 0.012),
            silence_end_s=_float(env, "CAPTIONS_SILENCE_END_S", 0.45),
            max_utterance_s=_float(env, "CAPTIONS_MAX_UTTERANCE_S", 5.0),
            soft_utterance_s=_float(env, "CAPTIONS_SOFT_UTTERANCE_S", 3.0),
            soft_silence_s=_float(env, "CAPTIONS_SOFT_SILENCE_S", 0.25),
            partials=_bool(env.get("CAPTIONS_PARTIALS"), True),
            partial_interval_s=_float(env, "CAPTIONS_PARTIAL_INTERVAL_S", 1.0),
            partial_model=env.get("CAPTIONS_PARTIAL_MODEL", "").strip(),
            direct_publish=_bool(env.get("CAPTIONS_DIRECT_PUBLISH"), True),
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
        if cfg.partial_interval_s < 0.3:
            raise ConfigError("CAPTIONS_PARTIAL_INTERVAL_S must be >= 0.3")
        if not (cfg.cpu_low < cfg.cpu_high <= cfg.cpu_critical):
            raise ConfigError("need CAPTIONS_CPU_LOW < CAPTIONS_CPU_HIGH <= CAPTIONS_CPU_CRITICAL")
        return cfg
