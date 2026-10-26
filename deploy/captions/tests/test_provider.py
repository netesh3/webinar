"""Deepgram streaming (provider.py) with a fake websocket: no network, no aiohttp."""

import asyncio
import json
import urllib.parse

import pytest

from fakes import FakeApi, FakeTranscriber
from webcaptions.config import Config, ConfigError
from webcaptions.cpuguard import Level
from webcaptions.live import LiveCaptioner
from webcaptions.provider import (
    BYTES_PER_MS,
    AudioClock,
    CostStats,
    DeepgramStream,
    FailoverTracker,
    SpeechGate,
    listen_url,
    parse_message,
)

NOW = 1_700_000_000_000


def cfg(**kw):
    base = dict(api_url="http://api", secret="x" * 40, provider="deepgram", deepgram_api_key="k" * 40)
    base.update(kw)
    return Config(**base)


def result(text, start, duration, is_final):
    return json.dumps({
        "type": "Results", "start": start, "duration": duration, "is_final": is_final,
        "channel": {"alternatives": [{"transcript": text, "confidence": 0.9}]},
    })


# ------------------------------------------------------------------ parsing


def test_interim_is_a_partial_and_is_final_a_final():
    p = parse_message(result("hello every", 1.0, 0.8, False))
    f = parse_message(result("Hello, everyone.", 1.0, 1.4, True))
    assert (p.kind, p.text, p.start_s, round(p.end_s, 3)) == ("partial", "hello every", 1.0, 1.8)
    assert (f.kind, f.text, round(f.end_s, 3)) == ("final", "Hello, everyone.", 2.4)


def test_non_transcript_messages_and_empty_text_are_ignored():
    assert parse_message(json.dumps({"type": "Metadata", "request_id": "x"})) is None
    assert parse_message(json.dumps({"type": "UtteranceEnd", "last_word_end": 2.0})) is None
    assert parse_message(result("   ", 0.0, 0.5, True)) is None
    assert parse_message("not json") is None


def test_url_has_the_streaming_settings_and_never_the_key():
    u = listen_url(cfg(deepgram_language="multi", deepgram_endpointing_ms=300))
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(u).query))
    assert u.startswith("wss://api.deepgram.com/v1/listen?")
    assert q["model"] == "nova-3" and q["language"] == "multi"
    assert q["encoding"] == "linear16" and q["sample_rate"] == "16000" and q["channels"] == "1"
    assert q["interim_results"] == "true" and q["endpointing"] == "300" and q["utterance_end_ms"] == "1000"
    assert "k" * 40 not in u


def test_config_requires_a_key_and_hides_it_from_repr():
    with pytest.raises(ConfigError):
        Config.from_env({"CAPTIONS_API_URL": "http://api", "CAPTIONS_SECRET": "x" * 40, "CAPTIONS_PROVIDER": "deepgram"})
    c = Config.from_env({
        "CAPTIONS_API_URL": "http://api", "CAPTIONS_SECRET": "x" * 40,
        "CAPTIONS_PROVIDER": "deepgram", "DEEPGRAM_API_KEY": "s3cr3t" * 6,
    })
    assert c.provider == "deepgram" and not c.local_models
    assert "s3cr3t" not in repr(c)


def test_provider_defaults_to_deepgram_with_a_key_else_local():
    base = {"CAPTIONS_API_URL": "http://api", "CAPTIONS_SECRET": "x" * 40}
    assert Config.from_env(base).provider == "local"
    assert Config.from_env(base).local_models
    assert Config.from_env({**base, "DEEPGRAM_API_KEY": "k" * 40}).provider == "deepgram"
    # An explicit local wins over a key that happens to be there.
    assert Config.from_env({**base, "DEEPGRAM_API_KEY": "k" * 40, "CAPTIONS_PROVIDER": "local"}).provider == "local"


# ------------------------------------------------------------------- timing


def test_audio_clock_maps_offsets_back_across_gaps():
    clock = AudioClock()
    # 1 s sent from NOW, then (speaker unselected for 5 s) 1 s more from NOW + 6000.
    for i in range(100):
        clock.sent(10 * BYTES_PER_MS, NOW + i * 10)
    for i in range(100):
        clock.sent(10 * BYTES_PER_MS, NOW + 6000 + i * 10)
    assert clock.wall_ms(0.0) == NOW
    assert clock.wall_ms(0.5) == NOW + 500
    assert clock.wall_ms(1.0) == NOW + 6000  # the second run's first sample
    assert clock.wall_ms(1.25) == NOW + 6250


# ---------------------------------------------------------------- failover


def test_failover_trips_after_three_failures_in_a_minute_and_success_clears():
    t = [0.0]
    f = FailoverTracker(limit=3, window_s=60, clock_s=lambda: t[0])
    assert not f.failure()
    t[0] = 10
    assert not f.failure()
    f.success()  # a working socket in between: back to zero
    t[0] = 20
    assert not f.failure()
    t[0] = 100  # the one at 20 s is outside the 60 s window by now
    assert not f.failure()
    t[0] = 101
    assert not f.failure()
    t[0] = 102
    assert f.failure() and f.tripped
    assert f.backoff_s() <= 15.0


# ----------------------------------------------------------- the socket itself


class FakeSocket:
    def __init__(self, replies=()):
        self.sent = []
        self.text = []
        self.closed = False
        self.inbox = asyncio.Queue()
        for r in replies:
            self.inbox.put_nowait(r)

    async def send_bytes(self, data):
        self.sent.append(data)

    async def send_str(self, data):
        self.text.append(data)
        if json.loads(data).get("type") == "CloseStream":
            self.inbox.put_nowait(None)

    async def receive_str(self):
        return await self.inbox.get()

    async def close(self):
        self.closed = True


def run(coro):
    return asyncio.run(coro)


def test_results_arrive_with_wall_times_and_close_ends_the_socket():
    sock = FakeSocket()
    events = []

    async def connect(url, headers):
        assert headers["Authorization"].startswith("Token ")
        return sock

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: events.append(e), FailoverTracker())
        await s.open()
        # Sent while the socket is still connecting: held, then sent in order (nothing lost).
        for i in range(100):
            await s.send(b"\0" * 320, NOW + 10 + i * 10)
        await asyncio.sleep(0.01)
        sock.inbox.put_nowait(result("hello every", 0.0, 0.6, False))
        sock.inbox.put_nowait(result("Hello, everyone.", 0.0, 0.9, True))
        await asyncio.sleep(0.01)
        await s.finalize()
        await s.close()
        return s

    s = run(scenario())
    assert events == [
        ("partial", NOW + 10, NOW + 610, "hello every"),
        ("final", NOW + 10, NOW + 910, "Hello, everyone."),
    ]
    assert len(sock.sent) == 100
    assert sock.text[:2] == ['{"type":"Finalize"}', '{"type":"CloseStream"}'] and sock.closed
    assert s.ws is None


def test_nothing_is_sent_or_opened_unless_the_gate_opened_it():
    calls = []

    async def connect(url, headers):
        calls.append(url)
        return FakeSocket()

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: None, FailoverTracker())
        await s.send(b"\0" * 320, NOW)
        await asyncio.sleep(0.01)
        return s

    s = run(scenario())
    assert calls == [] and s.ws is None


def test_a_failing_connect_counts_and_trips_the_room_to_paused():
    tracker = FailoverTracker(limit=2)
    health = []

    async def connect(url, headers):
        raise OSError("401 Unauthorized")

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: None, tracker, on_health=health.append)
        await s.open()
        await asyncio.sleep(0.01)
        s._retry_at = 0
        await s.send(b"\0" * 320, NOW + 10)
        await asyncio.sleep(0.01)
        await s.close()

    run(scenario())
    assert tracker.tripped and health == [False]


def test_a_dropped_socket_is_a_failure_and_reconnects_and_recovery_reports_live():
    socks = [FakeSocket(), FakeSocket()]
    tracker = FailoverTracker(limit=1)
    health = []

    async def connect(url, headers):
        return socks.pop(0)

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: None, tracker, on_health=health.append)
        await s.open()
        await asyncio.sleep(0.01)
        first = s.ws
        first.inbox.put_nowait(None)  # Deepgram closed it
        await asyncio.sleep(0.01)
        assert s.ws is None and tracker.tripped
        s._retry_at = 0
        await s.send(b"\0" * 320, NOW + 10)
        await asyncio.sleep(0.01)
        assert s.ws is not None and s.ws is not first
        assert s.ws.sent == [b"\0" * 320]  # held through the reconnect
        await s.close()

    run(scenario())
    assert health == [False, True] and not tracker.tripped


# ------------------------------------------------------------------- the gate

SPEECH, QUIET = 0.9, 0.05


def frames(gate, probs, start=0):
    """Push one 10 ms frame per probability; the frame's bytes are its index."""
    out = []
    for i, p in enumerate(probs, start):
        out.append([a if a[0] != "send" else ("send", a[2]) for a in gate.push(bytes([i % 256]), i * 10, p)])
    return out


def flat(actions):
    return [a for step in actions for a in step]


def test_gate_opens_on_speech_with_the_preroll_first():
    g = SpeechGate(preroll_ms=400, hangover_s=9.0, min_speech_ms=60)
    acts = flat(frames(g, [QUIET] * 50 + [SPEECH] * 6))
    assert acts[0] == ("open",)
    sends = [a[1] for a in acts[1:]]
    # 40 frames of pre-roll (400 ms) ending with the frame that confirmed speech.
    assert len(sends) == 40 and sends[-1] == 55 * 10 and sends[0] == 16 * 10
    assert g.state == "speaking"


def test_gate_ignores_a_click_shorter_than_min_speech():
    g = SpeechGate(min_speech_ms=60)
    assert flat(frames(g, [QUIET] * 10 + [SPEECH] * 3 + [QUIET] * 100)) == []
    assert g.state == "idle"


def test_gate_finalizes_on_end_of_speech_and_closes_after_the_hangover():
    g = SpeechGate(preroll_ms=100, hangover_s=2.0, end_silence_ms=500, min_speech_ms=10)
    acts = flat(frames(g, [SPEECH] * 100 + [QUIET] * 300))
    kinds = [a[0] for a in acts]
    assert kinds.count("open") == 1 and kinds.count("finalize") == 1 and kinds.count("close") == 1
    fin, close = kinds.index("finalize"), kinds.index("close")
    # Speech and the 0.5 s of silence that ended it are sent; nothing after the finalize.
    assert all(k == "send" for k in kinds[1:fin]) and kinds[fin + 1:] == ["close"]
    assert kinds.count("send") == 1 + 99 + 50  # the pre-roll's one frame, the speech, the end silence
    assert close == len(kinds) - 1 and g.state == "idle"


def test_speech_again_inside_the_hangover_reuses_the_socket():
    g = SpeechGate(preroll_ms=100, hangover_s=9.0, min_speech_ms=10)
    acts = flat(frames(g, [SPEECH] * 50 + [QUIET] * 200 + [SPEECH] * 50))
    kinds = [a[0] for a in acts]
    assert kinds.count("open") == 1 and "close" not in kinds and g.state == "speaking"


def test_mute_closes_at_once_and_forgets_the_preroll():
    g = SpeechGate(min_speech_ms=10)
    flat(frames(g, [SPEECH] * 20))
    assert g.force_close() == [("close",)]
    assert g.state == "idle" and not g.preroll
    assert g.force_close() == []  # nothing open, nothing to close


def test_cost_stats_count_audio_connection_time_and_sockets():
    t = [0.0]
    c = CostStats("webinar_abc", every_s=60, clock_s=lambda: t[0])
    c.opened(1)
    c.sent(1000 * BYTES_PER_MS)
    t[0] = 12.5
    c.closed(1)
    assert c.maybe_log() is None  # not a minute yet
    t[0] = 61
    line = c.maybe_log()
    assert line == ("caption cost webinar_abc: deepgram audio 1.0s, connected 12.5s, "
                    "opens 1, closes 1, open now 0, failures 0")


# --------------------------------------------- results into the room and API


def make_captioner(**kw):
    api = FakeApi()
    published = []
    c = LiveCaptioner(
        cfg(), api, "webinar_abc", FakeTranscriber(), FakeTranscriber(), lambda: Level.NORMAL,
        clock_ms=lambda: NOW, publish=lambda pkt: published.append(pkt) or True, display=lambda: True, **kw,
    )
    return c, api, published


def test_a_final_from_the_provider_is_published_and_posted_with_its_times():
    c, api, published = make_captioner()
    assert c.deliver("user_1", "Asha", "Hello, everyone.", NOW - 1500, NOW - 600, partial=False) == "Hello, everyone."
    assert api.lines == [dict(identity="user_1", text="Hello, everyone.", started=NOW - 1500, ended=NOW - 600,
                              partial=False, published=True)]
    assert published and published[0]["text"] == "Hello, everyone."
    assert c.stats.values("e2e") == [600]


def test_a_partial_is_shown_never_posted_and_not_after_its_final():
    c, api, published = make_captioner()
    assert c.deliver("user_1", "Asha", "hello every", NOW - 1500, NOW - 900, partial=True) == "hello every"
    assert api.lines == []  # not an edge room: the room has it, nothing stored
    c.deliver("user_1", "Asha", "Hello, everyone.", NOW - 1500, NOW - 600, partial=False)
    assert c.deliver("user_1", "Asha", "Hello, every", NOW - 1500, NOW - 500, partial=True) is None
    assert [p.get("partial", False) for p in published] == [True, False]


def test_nothing_is_delivered_while_captions_are_off():
    c, api, published = make_captioner()
    c.captions_off = True
    assert c.deliver("user_1", "Asha", "Hello", NOW - 1000, NOW - 500, partial=False) is None
    assert api.lines == [] and published == []
