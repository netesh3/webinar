"""The video box's caption worker: CAPTIONS_PROVIDER=deepgram.

    python -m webcaptions.stage_agent start

Runs as the captions-worker compose service next to LiveKit on each video box
(deploy/livekit-box/docker-compose.captions-worker.yml) and joins rooms when the API
dispatches it, as the captions box's agent does. Only stage microphones are heard (host,
co-hosts, panelists, promoted attendees: stage.is_stage), and only while unmuted; each goes
through Silero VAD, and a Deepgram socket is open only around speech (provider.SpeechGate).
No Whisper model, no CPU guard, no spool: the finals Deepgram sends are the session
transcript, posted when the room ends (stage.post_transcript).

When Deepgram keeps failing (3 failures in a minute) the room is reported paused, so the
browsers caption on device, and live again the moment a socket works: no local model to fall
back to on a video box (docs/decisions/2026-10-27-captions-providers.md).

Jobs run as threads of one process (the work is a websocket and a 2 MB model per speaker),
so a room costs megabytes rather than a ~150 MB process of its own.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor

from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, JobExecutorType, JobProcess, WorkerPermissions, cli

from .agent import DATA_TOPIC, _is_person, on_request
from .config import Config, deepgram_supports, job_language, job_skips_final, room_load
from .cpuguard import Level
from .live import LiveCaptioner
from .poster import ApiClient, captions_shown, sender_for, session_language
from .provider import CostStats, DeepgramStream, FailoverTracker, SileroVad, SpeechGate, aiohttp_connect
from .stage import RoomTranscript, SpeakerTrack, is_stage, post_transcript
from .transcriber import Result

log = logging.getLogger("captions.stage")

AUDIO_QUEUE_FRAMES = 500  # 5 s of 10 ms frames per track


class _NoModel:
    """LiveCaptioner's models, never asked to decode here: Deepgram transcribes."""

    name = "none"

    def load(self) -> None:
        pass

    def transcribe(self, audio, language=None, previous_language=None, final=False) -> Result:
        log.error("captions: a local decode was asked for on the video box worker")
        return Result(text="", language=language or "en", segments=[])


def _now_ms() -> int:
    return int(time.time() * 1000)


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = SileroVad.load_session()


async def entrypoint(ctx: JobContext) -> None:
    cfg = Config.from_env()
    room_name = ctx.job.room.name
    api = ApiClient(cfg.api_url, cfg.secret)
    skip = job_skips_final(ctx.job.metadata)
    session = ctx.proc.userdata.get("vad") or SileroVad.load_session()
    tracker = FailoverTracker(limit=3, window_s=60.0)
    cost = CostStats(room_name)
    transcript = RoomTranscript()
    connect = aiohttp_connect()
    loop = asyncio.get_running_loop()
    shown: list[bool | None] = [None]
    tracks: dict[str, SpeakerTrack] = {}
    tasks: dict[str, asyncio.Task[None]] = {}
    pubs: dict[str, rtc.RemoteTrackPublication] = {}
    background: set[asyncio.Task] = set()
    # deliver() publishes through publish(), which waits on this loop: never on it. In order.
    deliverer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="caption-deliver")
    poster = ThreadPoolExecutor(max_workers=1, thread_name_prefix="caption-post")

    def spawn(coro) -> None:
        t = asyncio.ensure_future(coro)
        background.add(t)
        t.add_done_callback(background.discard)

    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    room = ctx.room
    shown[0] = captions_shown(room.metadata)
    # The webinar's captions language: the room's (the host can change it live), else what the
    # job was dispatched with, else CAPTIONS_DEEPGRAM_LANGUAGE. Every stream reads it here.
    dispatched = job_language(ctx.job.metadata)
    lang = [session_language(room.metadata, dispatched, cfg)]

    def publish(packet: dict) -> bool:
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
        except RuntimeError:
            run()

    none = _NoModel()
    captioner = LiveCaptioner(
        cfg, api, room_name, none, none, lambda: Level.PAUSED if tracker.tripped else Level.NORMAL, None,
        partial=none, publish=publish, display=lambda: shown[0], sender_of=sender_of, post_async=post_async,
    )
    log.info(
        "captions joined %s (deepgram %s/%s, video box, shown %s)",
        room_name, cfg.deepgram_model, lang[0], shown[0],
    )
    if not deepgram_supports(lang[0], cfg):
        log.warning("captions: %s is in %r, which Deepgram does not caption; no streams until it changes", room_name, lang[0])

    def on_health(ok: bool) -> None:
        if not ok:
            log.warning("captions: deepgram keeps failing in %s; browsers caption on device until it recovers", room_name)
        else:
            log.info("captions: deepgram is back in %s", room_name)
        spawn(asyncio.to_thread(captioner.report))

    @room.on("room_metadata_changed")
    def _on_metadata(_old: str, new: str) -> None:
        shown[0] = captions_shown(new)
        was, lang[0] = lang[0], session_language(new, dispatched, cfg)
        if lang[0] != was:
            log.info("captions: %s language %s -> %s (from the next utterance)", room_name, was, lang[0])
            for sp in list(tracks.values()):
                spawn(sp.stream.relanguage())

    def wanted(p: rtc.RemoteParticipant, pub: rtc.TrackPublication) -> bool:
        return (
            _is_person(p)
            and pub.kind == rtc.TrackKind.KIND_AUDIO
            and pub.source == rtc.TrackSource.SOURCE_MICROPHONE
            and is_stage(p.metadata, bool(p.permissions.can_publish))
        )

    def subscribe_stage() -> None:
        """Subscribe to every stage microphone, muted or not (a muted track sends no audio, so
        it costs nothing until unmuted); never to an attendee's."""
        for p in room.remote_participants.values():
            for pub in p.track_publications.values():
                if wanted(p, pub) and not pub.subscribed:
                    log.info("captions subscribing to %s's microphone (%s)", p.identity, pub.sid)
                    pub.set_subscribed(True)
                elif pub.subscribed and pub.kind == rtc.TrackKind.KIND_AUDIO and not wanted(p, pub):
                    pub.set_subscribed(False)  # back in the audience

    async def pipeline(key: str, identity: str, name: str, track: rtc.Track, pub: rtc.RemoteTrackPublication) -> None:
        def on_event(kind: str, start_ms: int, end_ms: int, text: str) -> None:
            if kind == "final":
                transcript.add(identity, name, start_ms, end_ms, text)
            deliverer.submit(captioner.deliver, identity, name, text, start_ms, end_ms, partial=(kind == "partial"))

        stream = DeepgramStream(cfg, key, connect, on_event, tracker, cost, on_health, language=lambda: lang[0])
        gate = SpeechGate(cfg.vad_preroll_ms, cfg.vad_hangover_s)
        sp = SpeakerTrack(key, SileroVad(session), gate, stream)
        tracks[key] = sp
        audio = rtc.AudioStream(track, sample_rate=16_000, num_channels=1, frame_size_ms=10, capacity=AUDIO_QUEUE_FRAMES)
        try:
            async for ev in audio:
                await sp.frame(bytes(ev.frame.data), _now_ms() - 10, muted=pub.muted)
        except asyncio.CancelledError:
            pass
        finally:
            if tracks.get(key) is sp:
                del tracks[key]
            await sp.stop()
            await audio.aclose()

    def stop(key: str) -> None:
        pubs.pop(key, None)
        if t := tasks.pop(key, None):
            t.cancel()

    @room.on("track_published")
    def _on_published(_pub: rtc.RemoteTrackPublication, _p: rtc.RemoteParticipant) -> None:
        subscribe_stage()

    @room.on("participant_metadata_changed")
    def _on_meta(_p: rtc.Participant, _old: str, _new: str) -> None:
        subscribe_stage()  # promoted, or sent back to the audience

    @room.on("participant_permissions_changed")
    def _on_perms(*_args) -> None:
        subscribe_stage()

    @room.on("track_subscribed")
    def _on_subscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO or not wanted(p, pub):
            return
        key = p.identity
        stop(key)
        pubs[key] = pub
        tasks[key] = asyncio.ensure_future(pipeline(key, p.identity, p.name or p.identity, track, pub))

    @room.on("track_muted")
    def _on_muted(p: rtc.Participant, pub: rtc.TrackPublication) -> None:
        if (sp := tracks.get(p.identity)) is not None and pubs.get(p.identity) is pub:
            spawn(sp.mute())  # the socket closes now, not after the hangover

    @room.on("track_unsubscribed")
    def _on_unsubscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if pubs.get(p.identity) is pub:
            stop(p.identity)

    @room.on("track_unpublished")
    def _on_unpublished(pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if pubs.get(p.identity) is pub:
            stop(p.identity)

    @room.on("participant_disconnected")
    def _on_left(p: rtc.RemoteParticipant) -> None:
        stop(p.identity)

    async def ticker() -> None:
        while True:
            await asyncio.sleep(1.0)
            cost.maybe_log()
            captioner.stats.maybe_log()

    async def on_shutdown(reason: str) -> None:
        log.info("captions leaving %s: %s (posted %d, skipped %d)", room_name, reason, captioner.posted, captioner.skipped)
        for t in list(background):
            t.cancel()
        live = list(tasks.values())
        for t in live:
            t.cancel()
        await asyncio.gather(*live, return_exceptions=True)  # each closes its socket: last finals in
        cost.maybe_log(force=True)
        await asyncio.to_thread(deliverer.shutdown, True)
        await asyncio.to_thread(poster.shutdown, True)
        await asyncio.to_thread(post_transcript, api, room_name, "deepgram/" + cfg.deepgram_model, transcript, skip, lang[0])
        await asyncio.to_thread(captioner.report, None, True)

    ctx.add_shutdown_callback(on_shutdown)
    spawn(ticker())
    await asyncio.to_thread(captioner.report)
    subscribe_stage()


def build_server(cfg: Config) -> AgentServer:
    server = AgentServer(
        permissions=WorkerPermissions(
            can_publish=False, can_subscribe=True, can_publish_data=True, can_update_metadata=False, hidden=True
        ),
        setup_fnc=prewarm,
        load_fnc=lambda s: room_load(len(s.active_jobs), max(1, cfg.max_rooms)),
        load_threshold=0.99,
        job_executor_type=JobExecutorType.THREAD,
        num_idle_processes=1,
        initialize_process_timeout=60.0,
        shutdown_process_timeout=30.0,
        job_memory_warn_mb=500,
        port=cfg.health_port,
        prometheus_port=cfg.metrics_port or None,
    )
    server.rtc_session(entrypoint, agent_name=cfg.agent_name, on_request=on_request)
    return server


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = Config.from_env()
    if cfg.provider != "deepgram":
        raise SystemExit("webcaptions.stage_agent is the deepgram worker: set CAPTIONS_PROVIDER=deepgram and DEEPGRAM_API_KEY")
    cli.run_app(build_server(cfg))


if __name__ == "__main__":
    main()
