"""Configuration, from the environment. Every knob is documented in README.md."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Mapping

log = logging.getLogger("captions.config")

# English only. An old .env or worker metadata may still say CAPTIONS_LANGUAGE=auto / hi or
# set CAPTIONS_SCRIPT: those are warned about and ignored, never a reason not to start.
LANGUAGES = ("en",)

# Who transcribes live (provider.py). local: the Whisper models here (the captions box, now
# only a fallback, docs/decisions/2026-10-27-captions-providers.md); deepgram: Deepgram's
# streaming API from a light worker on the video box, no Whisper loaded at all.
PROVIDERS = ("local", "deepgram")


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
    # base.en by default: ~0.5-0.8 cores for 1-2 speakers against small.en's ~1.5-2, measured
    # to matter on the shared c-4 (24 Oct 2026). CAPTIONS_MODEL=small.en for the larger one.
    model: str = "base.en"
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
    # The worker's Prometheus endpoint (livekit-agents: rooms held, load, child processes), for
    # Grafana Alloy on the captions box. 0 is off.
    metrics_port: int = 0

    # Live transcription provider (PROVIDERS). With deepgram, each stage speaker's microphone
    # streams to Deepgram (Nova-3) over a websocket, only while the voice activity detector
    # hears speech (provider.SpeechGate); interim/final results become partials/finals, and
    # the finals are the session transcript (posted when the room ends; nothing spooled, no
    # after-session pass). The key never appears in repr() or a log line.
    # Default: deepgram when DEEPGRAM_API_KEY is set, else local.
    provider: str = "local"
    deepgram_api_key: str = field(default="", repr=False)
    deepgram_model: str = "nova-3"
    # Only the fallback now: each webinar names its captions language (api/types
    # captions_language.go), sent in the dispatch metadata and the room metadata
    # (session_language). "multi" is Nova-3's code-switching mode, which covers only English,
    # Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian and Dutch.
    deepgram_language: str = "multi"
    # Silence (ms) before Deepgram ends an utterance, and the gap that sends UtteranceEnd.
    deepgram_endpointing_ms: int = 300
    deepgram_utterance_end_ms: int = 1000
    # The speech gate: audio kept from before speech starts (sent first so the first word is
    # not cut) and how long a socket stays open after speech stops before it is closed.
    vad_preroll_ms: int = 400
    vad_hangover_s: float = 9.0

    @property
    def local_models(self) -> bool:
        """Whether this worker loads the Whisper models at all (never with deepgram)."""
        return self.provider == "local"

    @property
    def cpu_threads(self) -> int:
        """Every vCPU: the after-session pass, which only runs while no room is live."""
        return max(1, int(self.cpus))

    @property
    def live_threads(self) -> int:
        """A room's live decoder threads: the vCPUs shared between max_rooms rooms, at least 1.
        Each room's job process loads its own models, and all of them at cpu_threads would
        oversubscribe the box as soon as a second room joined (2026-10-27)."""
        return max(1, int(self.cpus) // max(1, self.max_rooms))

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
            log.warning("CAPTIONS_LANGUAGE=%s ignored: captions are English only, using en", language)
            language = "en"
        if env.get("CAPTIONS_SCRIPT", "").strip():
            log.warning("CAPTIONS_SCRIPT ignored: captions are English only")
        cfg = cls(
            api_url=api_url,
            secret=secret,
            agent_name=env.get("CAPTIONS_AGENT_NAME", "").strip() or "webinar-captions",
            model=env.get("CAPTIONS_MODEL", "").strip() or "base.en",
            fallback_model=env.get("CAPTIONS_FALLBACK_MODEL", "").strip() or "base.en",
            final_model=env.get("CAPTIONS_FINAL_MODEL", "").strip() or "large-v3-turbo",
            final_enabled=_bool(env.get("CAPTIONS_FINAL_ENABLED"), True),
            model_dir=env.get("CAPTIONS_MODEL_DIR", "").strip() or "/models",
            language=language,
            prompt=env.get("CAPTIONS_PROMPT", "").strip(),
            max_speakers=_int(env, "CAPTIONS_MAX_SPEAKERS", 2),
            speaker_linger_s=_float(env, "CAPTIONS_SPEAKER_LINGER_S", 3.0),
            max_rooms=_int(env, "CAPTIONS_MAX_ROOMS", 0) or default_max_rooms(_float(env, "CAPTIONS_CPUS", 2.0)),
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
            metrics_port=_int(env, "CAPTIONS_METRICS_PORT", 0),
            provider=(
                env.get("CAPTIONS_PROVIDER", "").strip().lower()
                or ("deepgram" if env.get("DEEPGRAM_API_KEY", "").strip() else "local")
            ),
            deepgram_api_key=env.get("DEEPGRAM_API_KEY", "").strip(),
            deepgram_model=env.get("CAPTIONS_DEEPGRAM_MODEL", "").strip() or "nova-3",
            deepgram_language=env.get("CAPTIONS_DEEPGRAM_LANGUAGE", "").strip() or "multi",
            deepgram_endpointing_ms=_int(env, "CAPTIONS_DEEPGRAM_ENDPOINTING_MS", 300),
            deepgram_utterance_end_ms=_int(env, "CAPTIONS_DEEPGRAM_UTTERANCE_END_MS", 1000),
            vad_preroll_ms=_int(env, "CAPTIONS_VAD_PREROLL_MS", 400),
            vad_hangover_s=_float(env, "CAPTIONS_VAD_HANGOVER_S", 9.0),
        )
        if cfg.provider not in PROVIDERS:
            raise ConfigError(f"CAPTIONS_PROVIDER must be one of {', '.join(PROVIDERS)}, got {cfg.provider!r}")
        if cfg.provider == "deepgram" and not cfg.deepgram_api_key:
            raise ConfigError("CAPTIONS_PROVIDER=deepgram needs DEEPGRAM_API_KEY")
        if cfg.deepgram_utterance_end_ms and cfg.deepgram_utterance_end_ms < 1000:
            raise ConfigError("CAPTIONS_DEEPGRAM_UTTERANCE_END_MS must be 0 (off) or >= 1000 (Deepgram's minimum)")
        if not (0 <= cfg.metrics_port <= 65535) or (cfg.metrics_port and cfg.metrics_port == cfg.health_port):
            raise ConfigError("CAPTIONS_METRICS_PORT must be 0 (off) or a port other than CAPTIONS_HEALTH_PORT")
        if cfg.max_speakers < 1:
            raise ConfigError("CAPTIONS_MAX_SPEAKERS must be >= 1")
        if cfg.partial_interval_s < 0.3:
            raise ConfigError("CAPTIONS_PARTIAL_INTERVAL_S must be >= 0.3")
        if not (cfg.cpu_low < cfg.cpu_high <= cfg.cpu_critical):
            raise ConfigError("need CAPTIONS_CPU_LOW < CAPTIONS_CPU_HIGH <= CAPTIONS_CPU_CRITICAL")
        return cfg


def default_max_rooms(cpus: float) -> int:
    """One room per two vCPUs, at least one: the API's own default (config.CaptionsRoomsFor).
    Measured 2026-10-26: one room of continuous speech held 1.2–1.6 cores of an s-2vcpu-4gb
    and caption delay p90 reached 7.8–8.7 s (docs/decisions/2026-10-27-captions-box-size.md)."""
    return max(1, int(cpus) // 2)


def room_load(active_jobs: int, max_rooms: int) -> float:
    """The worker's load as LiveKit sees it: rooms held over CAPTIONS_MAX_ROOMS, never the
    host CPU (the CPU guard handles that). Below the threshold (agent.py) LiveKit offers the
    worker rooms; at max_rooms it is full."""
    return min(1.0, max(0, active_jobs) / max(1, max_rooms))


# The captions languages Deepgram Nova-3 streams (its docs, 2026-10-27), as the API's
# types.CaptionLanguages codes. Malayalam ("ml") is on the API's list but not here: a room in
# it gets no Deepgram stream (Deepgram would hear Arabic), until a second provider has it.
DEEPGRAM_LANGUAGES = frozenset({"en-IN", "hi", "multi", "ta", "te", "kn", "mr", "bn", "gu"})


def deepgram_supports(language: str, cfg: Config | None = None) -> bool:
    """Whether captions in `language` may stream to Deepgram: one of DEEPGRAM_LANGUAGES, or
    the operator's own CAPTIONS_DEEPGRAM_LANGUAGE (the fallback, "multi" by default)."""
    if not language:
        return False
    return language in DEEPGRAM_LANGUAGES or (cfg is not None and language == cfg.deepgram_language)


def job_language(metadata: str | None) -> str | None:
    """The captions language the API dispatched the job with ("language", a
    types.CaptionLanguages code). None when absent or unreadable (an older API)."""
    if not metadata:
        return None
    try:
        md = json.loads(metadata)
    except ValueError:
        return None
    v = md.get("language") if isinstance(md, dict) else None
    return v.strip() if isinstance(v, str) and v.strip() else None


def job_skips_final(metadata: str | None) -> bool:
    """Whether a job's dispatch metadata asks for no after-session pass ("final":"skip").
    Anything unreadable keeps the pass: a real session must never lose its transcript."""
    if not metadata:
        return False
    try:
        md = json.loads(metadata)
    except ValueError:
        return False
    return isinstance(md, dict) and md.get("final") == "skip"
