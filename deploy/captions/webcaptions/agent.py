"""The LiveKit side: a worker that joins a room when the API dispatches it.

    python -m webcaptions.agent start

The API creates an explicit agent dispatch (agent name CAPTIONS_AGENT_NAME) for a room
when the host turns server captions on, and deletes it when they are turned off or the
session ends; LiveKit then starts / ends this agent's job for that room. The agent joins
hidden and publishes no media (only its caption data packets). It subscribes to every
person's microphone and share audio: LiveKit only tells a participant about the active
speakers it is subscribed to, so subscribing to the selection alone means nobody is ever
selected (selection.py). Only the lines of the speakers SpeakerSelector picks from those
active-speaker updates (and share audio) reach the model.

The main process also runs the finalizer thread (after-session transcripts). Job processes
are LiveKit's own (one per room), each with its live models prewarmed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, JobProcess, JobRequest, WorkerPermissions, cli

from .config import Config
from .cpuguard import CpuGuard, GuardMonitor, Level
from .finalizer import Finalizer
from .live import LiveCaptioner
from .poster import ApiClient, captions_shown, sender_for
from .segmenter import Segmenter, pcm16_to_float
from .selection import FrameWatch, LineGate, SpeakerSelector, main_source, pipeline_key, wants_key
from .spool import RoomSpool, close_orphans, live_rooms
from .transcriber import WhisperTranscriber

log = logging.getLogger("captions.agent")

IDENTITY_PREFIX = "CAP_"  # filtered from every roster; see api/internal/lk/agents.go
DATA_TOPIC = "webcast"  # the room packets' topic: api/internal/api/say.go dataTopic, web/lib/realtime.ts


def _guard(cfg: Config) -> CpuGuard:
    return CpuGuard(cfg.cpu_high, cfg.cpu_critical, cfg.cpu_low, cfg.cpu_high_for_s, cfg.cpu_low_for_s)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _models(cfg: Config) -> dict[str, WhisperTranscriber]:
    """live, fallback and partial, one instance per distinct model name (the partial model
    is the fallback by default, so it costs no extra memory)."""
    by_name: dict[str, WhisperTranscriber] = {}

    def get(name: str) -> WhisperTranscriber:
        if name not in by_name:
            by_name[name] = WhisperTranscriber(name, cfg.cpu_threads, cfg.model_dir, cfg.prompt)
        return by_name[name]

    return {"live": get(cfg.model), "fallback": get(cfg.fallback_model), "partial": get(cfg.partial_model_name)}


def prewarm(proc: JobProcess) -> None:
    """Runs once per job process, before it is handed a room: the live models load here so
    a dispatch does not wait on them. (A throwaway first decode was measured too: CTranslate2's
    first call is no slower than the rest, so there is nothing more to warm.)"""
    cfg = Config.from_env()
    models = _models(cfg)
    for t in {id(t): t for t in models.values()}.values():
        t.load()
    proc.userdata.update(models)


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
    models = _models(cfg) if "live" not in ctx.proc.userdata else ctx.proc.userdata
    spool = RoomSpool(cfg.spool_dir, room_name, ctx.job.id, cfg.spool_max_mb * 1024 * 1024) if cfg.final_enabled else None
    monitor = GuardMonitor(_guard(cfg), cfg.cpu_sample_s)
    selector = SpeakerSelector(cfg.max_speakers, cfg.speaker_linger_s)

    loop = asyncio.get_running_loop()
    wake = asyncio.Event()
    active: list[str] = []
    pipelines: dict[str, asyncio.Task[None]] = {}
    segs: dict[str, Segmenter] = {}
    pubs: dict[str, rtc.RemoteTrackPublication] = {}  # pipeline key -> its publication
    requested: set[str] = set()  # publication sids we asked to subscribe to
    watch = FrameWatch(60.0)
    background: set[asyncio.Task[None]] = set()
    # Finals reach the API in order on one thread, off the decoder: the room already has
    # the line by the time the POST starts.
    poster = ThreadPoolExecutor(max_workers=1, thread_name_prefix="caption-post")
    shown: list[bool | None] = [None]

    def spawn(coro) -> None:
        t = asyncio.ensure_future(coro)
        background.add(t)
        t.add_done_callback(background.discard)

    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    room = ctx.room
    shown[0] = captions_shown(room.metadata)

    def publish(packet: dict) -> bool:
        """From the decoder thread: the packet onto the room, waited for briefly so the API
        knows whether it still has to relay it."""
        data = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        fut = asyncio.run_coroutine_threadsafe(
            room.local_participant.publish_data(data, reliable=True, topic=DATA_TOPIC), loop
        )
        try:
            fut.result(timeout=2.0)
            return True
        except Exception as err:
            fut.cancel()
            log.warning("caption publish to %s failed (the API relays it): %s", room_name, err)
            return False

    def sender_of(identity: str, name: str) -> dict:
        p = room.remote_participants.get(identity)
        return sender_for(identity, p.name if p and p.name else name, p.metadata if p else None)

    def post_async(fn) -> None:
        def run() -> None:
            try:
                fn()
            except Exception:
                log.exception("caption post failed")

        try:
            poster.submit(run)
        except RuntimeError:  # shutting down: a decode that was mid-flight posts inline
            run()

    captioner = LiveCaptioner(
        cfg, api, room_name, models["live"], models["fallback"], lambda: monitor.level, spool,
        partial=models["partial"], publish=publish, display=lambda: shown[0], sender_of=sender_of,
        post_async=post_async,
    )
    log.info(
        "captions joined %s (model %s, partials %s, language %s, shown %s)",
        room_name, cfg.model, cfg.partial_model_name if cfg.partials else "off", cfg.language, shown[0],
    )

    @room.on("room_metadata_changed")
    def _on_metadata(_old: str, new: str) -> None:
        shown[0] = captions_shown(new)

    def apply_selection() -> None:
        # Every person's audio is subscribed, whoever is selected: LiveKit sends active-
        # speaker updates only for subscribed participants, so the selection (which reads
        # them) cannot also decide the subscriptions. The selection gates the model instead,
        # in pipeline().
        selector.update(active)
        for p in room.remote_participants.values():
            if not _is_person(p):
                continue
            for pub in p.track_publications.values():
                if pub.kind != rtc.TrackKind.KIND_AUDIO or pub.source not in _AUDIO_SOURCES:
                    continue
                if not pub.subscribed and pub.sid not in requested:
                    requested.add(pub.sid)
                    log.info(
                        "captions subscribing to %s %s (%s)",
                        p.identity, "share audio" if _is_share(pub) else "microphone", pub.sid,
                    )
                    pub.set_subscribed(True)

    def level_changed(old: Level, new: Level) -> None:
        log.warning("cpu guard %s -> %s (host %.0f%%)", old.name, new.name, monitor.last_usage or -1)
        selector.max_speakers = 1 if new >= Level.DEGRADED else cfg.max_speakers
        apply_selection()
        spawn(asyncio.to_thread(captioner.report, new))

    monitor.on_change = lambda old, new: loop.call_soon_threadsafe(level_changed, old, new)
    monitor.start()

    async def pipeline(key: str, identity: str, name: str, track: rtc.Track) -> None:
        seg = Segmenter(
            cfg.energy_gate, cfg.silence_end_s, cfg.max_utterance_s,
            soft_utterance_s=cfg.soft_utterance_s, soft_silence_s=cfg.soft_silence_s,
        )
        segs[key] = seg
        gate = LineGate()
        watch.start(key, time.monotonic())
        stream = rtc.AudioStream(track, sample_rate=16_000, num_channels=1)
        try:
            async for ev in stream:
                if watch.frame(key, time.monotonic()):
                    log.info("captions: first audio from %s", key)
                # Every subscribed source is segmented (one RMS per frame); only the
                # selected speakers' lines (and share audio) go to the model.
                chosen = wants_key(key, selector.selected)
                for utt in seg.push(pcm16_to_float(ev.frame.data), _now_ms()):
                    if gate.take(chosen):
                        captioner.add(identity, name, utt)
                        wake.set()
                gate.note(chosen, seg.in_speech)
                # Interim text for the one source the room is listening to, while it talks.
                if chosen and seg.in_speech and cfg.partials and captioner.partials_allowed():
                    picked = selector.selected
                    speaking = [k for k, s in segs.items() if s.in_speech and wants_key(k, picked)]
                    if main_source(active, speaking) == key:
                        snap = seg.take_partial(cfg.partial_interval_s)
                        if snap is not None and captioner.offer_partial(identity, name, snap):
                            wake.set()
        except asyncio.CancelledError:
            pass
        finally:
            log.info("captions: audio from %s ended (%d frames)", key, watch.frames(key))
            if segs.get(key) is seg:
                del segs[key]
                watch.stop(key)
            for utt in seg.flush():
                if gate.take(wants_key(key, selector.selected)):
                    captioner.add(identity, name, utt)
                    wake.set()
            await stream.aclose()

    async def decoder() -> None:
        # Finals first, always; a partial only when none is waiting.
        while True:
            await wake.wait()
            wake.clear()
            while True:
                if (p := captioner.next_pending()) is not None:
                    work = captioner.process
                elif (p := captioner.next_partial()) is not None:
                    work = captioner.process_partial
                else:
                    break
                try:
                    await asyncio.to_thread(work, p)
                except Exception:
                    log.exception("caption decode failed")

    async def ticker() -> None:
        while True:
            await asyncio.sleep(1.0)
            apply_selection()  # lets lingering slots expire on time
            captioner.stats.maybe_log()
            for key in watch.due(time.monotonic(), muted=lambda k: bool((pub := pubs.get(k)) and pub.muted)):
                log.warning("captions: no audio frames from %s for %.0fs while subscribed", key, watch.quiet_s)

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
        log.info("captions subscribed to %s (%s, muted %s)", key, pub.sid, pub.muted)
        pubs[key] = pub
        if old := pipelines.pop(key, None):
            old.cancel()
        # Captioned under the sharer: the line is theirs on screen, as a mic line is.
        pipelines[key] = asyncio.ensure_future(pipeline(key, p.identity, p.name or p.identity, track))

    @room.on("track_unsubscribed")
    def _on_unsubscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        key = pipeline_key(p.identity, _is_share(pub))
        log.info("captions unsubscribed from %s (%s)", key, pub.sid)
        requested.discard(pub.sid)
        pubs.pop(key, None)
        if t := pipelines.pop(key, None):
            t.cancel()

    @room.on("track_unpublished")
    def _on_unpublished(pub: rtc.RemoteTrackPublication, _p: rtc.RemoteParticipant) -> None:
        requested.discard(pub.sid)

    @room.on("participant_disconnected")
    def _on_left(p: rtc.RemoteParticipant) -> None:
        selector.remove(p.identity)
        for pub in p.track_publications.values():
            requested.discard(pub.sid)
        for key in (p.identity, pipeline_key(p.identity, True)):
            pubs.pop(key, None)
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
        await asyncio.to_thread(poster.shutdown, True)  # the last finals reach the API
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
            # can_publish_data: the agent publishes its caption packets to the room itself
            # (live.py). Still no media and no metadata, and hidden from every roster.
            can_publish=False, can_subscribe=True, can_publish_data=True, can_update_metadata=False, hidden=True
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
