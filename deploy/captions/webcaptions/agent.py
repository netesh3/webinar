"""The LiveKit side: a worker that joins a room when the API dispatches it.

    python -m webcaptions.agent start

The API creates an explicit agent dispatch (agent name CAPTIONS_AGENT_NAME) for a room
when the host turns server captions on, and deletes it when they are turned off or the
session ends; LiveKit then starts / ends this agent's job for that room. The agent joins
hidden, cannot publish, and subscribes to nothing by default — only to the microphones of
the speakers SpeakerSelector picks from LiveKit's active-speaker updates.

The main process also runs the finalizer thread (after-session transcripts). Job processes
are LiveKit's own (one per room), each with its live models prewarmed.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time

from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, JobProcess, JobRequest, WorkerPermissions, cli

from .config import Config
from .cpuguard import CpuGuard, GuardMonitor, Level
from .finalizer import Finalizer
from .live import LiveCaptioner
from .poster import ApiClient
from .segmenter import Segmenter, pcm16_to_float
from .selection import SHARE_SUFFIX, SpeakerSelector, pipeline_key, wants_audio
from .spool import RoomSpool, close_orphans, live_rooms
from .transcriber import WhisperTranscriber

log = logging.getLogger("captions.agent")

IDENTITY_PREFIX = "CAP_"  # filtered from every roster; see api/internal/lk/agents.go


def _guard(cfg: Config) -> CpuGuard:
    return CpuGuard(cfg.cpu_high, cfg.cpu_critical, cfg.cpu_low, cfg.cpu_high_for_s, cfg.cpu_low_for_s)


def _now_ms() -> int:
    return int(time.time() * 1000)


def prewarm(proc: JobProcess) -> None:
    """Runs once per job process, before it is handed a room: the live models load here so
    a dispatch does not wait on them."""
    cfg = Config.from_env()
    live = WhisperTranscriber(cfg.model, cfg.cpu_threads, cfg.model_dir, cfg.prompt)
    fallback = WhisperTranscriber(cfg.fallback_model, cfg.cpu_threads, cfg.model_dir, cfg.prompt)
    live.load()
    if cfg.fallback_model != cfg.model:
        fallback.load()
    proc.userdata["live"] = live
    proc.userdata["fallback"] = fallback


async def on_request(req: JobRequest) -> None:
    # One stable identity per room: a second dispatch (or a restart) replaces the first
    # agent instead of putting two caption agents in the room.
    await req.accept(identity=IDENTITY_PREFIX + req.room.name, name="Captions")


_AUDIO_SOURCES = (rtc.TrackSource.SOURCE_MICROPHONE, rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO)


def _is_share(pub: rtc.TrackPublication) -> bool:
    return pub.source == rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO


def _is_person(p: rtc.RemoteParticipant) -> bool:
    if p.identity.startswith((IDENTITY_PREFIX, "EG_", "REC_")):
        return False
    return p.kind not in (rtc.ParticipantKind.PARTICIPANT_KIND_AGENT, rtc.ParticipantKind.PARTICIPANT_KIND_EGRESS)


async def entrypoint(ctx: JobContext) -> None:
    cfg = Config.from_env()
    room_name = ctx.job.room.name
    api = ApiClient(cfg.api_url, cfg.secret)
    live_t = ctx.proc.userdata.get("live") or WhisperTranscriber(cfg.model, cfg.cpu_threads, cfg.model_dir, cfg.prompt)
    fallback_t = ctx.proc.userdata.get("fallback") or WhisperTranscriber(
        cfg.fallback_model, cfg.cpu_threads, cfg.model_dir, cfg.prompt
    )
    spool = RoomSpool(cfg.spool_dir, room_name, ctx.job.id, cfg.spool_max_mb * 1024 * 1024) if cfg.final_enabled else None
    monitor = GuardMonitor(_guard(cfg), cfg.cpu_sample_s)
    captioner = LiveCaptioner(cfg, api, room_name, live_t, fallback_t, lambda: monitor.level, spool)
    selector = SpeakerSelector(cfg.max_speakers, cfg.speaker_linger_s)

    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    active: list[str] = []
    pipelines: dict[str, asyncio.Task[None]] = {}
    background: set[asyncio.Task[None]] = set()

    def spawn(coro) -> None:
        t = asyncio.ensure_future(coro)
        background.add(t)
        t.add_done_callback(background.discard)

    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    room = ctx.room
    log.info("captions joined %s (model %s, language %s, script %s)", room_name, cfg.model, cfg.language, cfg.script)

    def apply_selection() -> None:
        chosen = selector.update(active)
        for p in room.remote_participants.values():
            if not _is_person(p):
                continue
            for pub in p.track_publications.values():
                if pub.kind != rtc.TrackKind.KIND_AUDIO or pub.source not in _AUDIO_SOURCES:
                    continue
                want = wants_audio(p.identity, _is_share(pub), chosen)
                if pub.subscribed != want:
                    pub.set_subscribed(want)
        # Microphones that dropped out of the selection stop; share audio stops only when
        # its track goes away (track_unsubscribed).
        for key in list(pipelines):
            if not key.endswith(SHARE_SUFFIX) and key not in chosen:
                pipelines.pop(key).cancel()

    def level_changed(old: Level, new: Level) -> None:
        log.warning("cpu guard %s -> %s (host %.0f%%)", old.name, new.name, monitor.last_usage or -1)
        selector.max_speakers = 1 if new >= Level.DEGRADED else cfg.max_speakers
        apply_selection()
        spawn(asyncio.to_thread(captioner.report, new))

    monitor.on_change = lambda old, new: loop.call_soon_threadsafe(level_changed, old, new)
    monitor.start()

    async def pipeline(identity: str, name: str, track: rtc.Track) -> None:
        seg = Segmenter(cfg.energy_gate, cfg.silence_end_s, cfg.max_utterance_s)
        stream = rtc.AudioStream(track, sample_rate=16_000, num_channels=1)
        try:
            async for ev in stream:
                for utt in seg.push(pcm16_to_float(ev.frame.data), _now_ms()):
                    captioner.add(identity, name, utt)
                    wake.set()
        except asyncio.CancelledError:
            pass
        finally:
            for utt in seg.flush():
                captioner.add(identity, name, utt)
                wake.set()
            await stream.aclose()

    async def decoder() -> None:
        while True:
            await wake.wait()
            wake.clear()
            while (p := captioner.next_pending()) is not None:
                try:
                    await asyncio.to_thread(captioner.process, p)
                except Exception:
                    log.exception("caption decode failed")

    async def ticker() -> None:
        while True:
            await asyncio.sleep(1.0)
            apply_selection()  # lets lingering slots expire on time

    @room.on("active_speakers_changed")
    def _on_speakers(speakers: list[rtc.Participant]) -> None:
        me = room.local_participant.identity
        active[:] = [s.identity for s in speakers if s.identity != me]
        apply_selection()

    @room.on("track_published")
    def _on_published(_pub: rtc.RemoteTrackPublication, _p: rtc.RemoteParticipant) -> None:
        apply_selection()

    @room.on("track_subscribed")
    def _on_subscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        key = pipeline_key(p.identity, _is_share(pub))
        if old := pipelines.pop(key, None):
            old.cancel()
        # Captioned under the sharer: the line is theirs on screen, as a mic line is.
        pipelines[key] = asyncio.ensure_future(pipeline(p.identity, p.name or p.identity, track))

    @room.on("track_unsubscribed")
    def _on_unsubscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO and (t := pipelines.pop(pipeline_key(p.identity, _is_share(pub)), None)):
            t.cancel()

    @room.on("participant_disconnected")
    def _on_left(p: rtc.RemoteParticipant) -> None:
        selector.remove(p.identity)
        for key in (p.identity, pipeline_key(p.identity, True)):
            if t := pipelines.pop(key, None):
                t.cancel()

    async def on_shutdown(reason: str) -> None:
        log.info("captions leaving %s: %s (posted %d, skipped %d)", room_name, reason, captioner.posted, captioner.skipped)
        monitor.stop()
        for t in list(pipelines.values()) + list(background):
            t.cancel()
        await asyncio.gather(*pipelines.values(), return_exceptions=True)
        if spool is not None:
            spool.mark_done()  # the finalizer in the main process picks it up
        await asyncio.to_thread(captioner.report, None, True)

    ctx.add_shutdown_callback(on_shutdown)
    spawn(decoder())
    spawn(ticker())
    await asyncio.to_thread(captioner.report)
    apply_selection()


def _load(server: AgentServer) -> float:
    cfg = Config.from_env()
    return min(1.0, len(server.active_jobs) / max(1, cfg.max_rooms))


def build_server(cfg: Config) -> AgentServer:
    server = AgentServer(
        permissions=WorkerPermissions(
            can_publish=False, can_subscribe=True, can_publish_data=False, can_update_metadata=False, hidden=True
        ),
        setup_fnc=prewarm,
        load_fnc=_load,
        # Our own load (rooms held / CAPTIONS_MAX_ROOMS), not the host CPU: on an egress box
        # the host is busy BY DESIGN, and the CPU guard, not job refusal, handles that.
        load_threshold=0.99,
        num_idle_processes=1,
        initialize_process_timeout=300.0,
        shutdown_process_timeout=30.0,
        job_memory_warn_mb=2000,
        port=cfg.health_port,
    )
    server.rtc_session(entrypoint, agent_name=cfg.agent_name, on_request=on_request)
    return server


def _start_finalizer(cfg: Config) -> None:
    if not cfg.final_enabled:
        return
    if (n := close_orphans(cfg.spool_dir)) > 0:
        log.info("final transcript: %d room(s) left by a previous run", n)
    monitor = GuardMonitor(_guard(cfg), cfg.cpu_sample_s).start()
    final = WhisperTranscriber(cfg.final_model, cfg.cpu_threads, cfg.model_dir)

    def idle(stop: threading.Event) -> bool:
        # Never alongside live captions (they share the container's CPU cap), and only
        # while the host as a whole is quiet.
        while live_rooms(cfg.spool_dir) > 0 or monitor.level != Level.NORMAL:
            if stop.wait(10.0):
                return False
        return True

    fin = Finalizer(
        cfg,
        ApiClient(cfg.api_url, cfg.secret, timeout=60.0),
        final,
        wait_until_idle=idle,
        unload=final.unload,
    )
    threading.Thread(target=fin.loop, name="finalizer", daemon=True).start()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = Config.from_env()
    _start_finalizer(cfg)
    cli.run_app(build_server(cfg))


if __name__ == "__main__":
    main()
