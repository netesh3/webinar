"""Caption latency: soft cuts, partial scheduling and gating, direct publish, the packets."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest

from fakes import FakeApi, FakeTranscriber
from webcaptions.config import Config
from webcaptions.cpuguard import Level
from webcaptions.live import PARTIAL_STALE_MS, LiveCaptioner
from webcaptions.metrics import LatencyStats, percentile
from webcaptions.poster import ApiClient, caption_packet, caption_payload, captions_shown, sender_for
from webcaptions.segmenter import Segmenter, Utterance
from webcaptions.selection import main_source
from webcaptions.spool import RoomSpool, read_index

SR = 16000
FRAME = 320
NOW = 1_700_000_000_000


def frames(seconds, amplitude):
    rng = np.random.default_rng(1)
    for _ in range(int(seconds * SR / FRAME)):
        yield (rng.standard_normal(FRAME) * amplitude).astype(np.float32)


def run(seg, chunks, t0=1_000_000, partial_every=None):
    out, partials, t = [], [], t0
    for f in chunks:
        t += 20
        out.extend(seg.push(f, t))
        if partial_every is not None and (p := seg.take_partial(partial_every)) is not None:
            partials.append(p)
    return out, partials


# ------------------------------------------------------------------ segmenter


def test_soft_cut_closes_a_monologue_at_the_first_breath_after_three_seconds():
    seg = Segmenter(silence_end_s=0.45, max_utterance_s=5.0, soft_utterance_s=3.0, soft_silence_s=0.25)
    # 3.2 s of speech, a 0.3 s breath (shorter than silence_end_s), more speech.
    chunks = list(frames(3.2, 0.2)) + list(frames(0.3, 0.001)) + list(frames(2.0, 0.2))
    out, _ = run(seg, chunks)
    assert len(out) == 1
    assert 3.2 <= out[0].duration_s <= 3.2 + 0.3 + 0.05


def test_a_breath_before_the_soft_length_does_not_cut():
    seg = Segmenter(silence_end_s=0.45, max_utterance_s=5.0, soft_utterance_s=3.0, soft_silence_s=0.25)
    chunks = list(frames(1.5, 0.2)) + list(frames(0.3, 0.001)) + list(frames(1.0, 0.2))
    out, _ = run(seg, chunks)
    assert out == [] and seg.in_speech


def test_no_soft_length_is_the_old_behaviour():
    seg = Segmenter(silence_end_s=0.6, max_utterance_s=6.0)
    chunks = list(frames(4.0, 0.2)) + list(frames(0.3, 0.001)) + list(frames(1.0, 0.2))
    out, _ = run(seg, chunks)
    assert out == []


def test_hard_cap_still_applies():
    seg = Segmenter(max_utterance_s=5.0, soft_utterance_s=3.0)
    out, _ = run(seg, frames(11, 0.2))
    assert len(out) == 2 and all(u.duration_s <= 5.05 for u in out)


def test_partials_are_handed_out_once_per_interval_and_reset_per_line():
    seg = Segmenter(silence_end_s=0.45, max_utterance_s=5.0)
    chunks = list(frames(3.5, 0.2)) + list(frames(0.6, 0.001)) + list(frames(1.5, 0.2))
    out, partials = run(seg, chunks, partial_every=1.0)
    assert len(out) == 1
    first = [p for p in partials if p.started_at_ms == out[0].started_at_ms]
    # One per second of the line so far.
    assert [round(p.duration_s) for p in first] == [1, 2, 3]
    # The next line starts its own count.
    rest = [p for p in partials if p.started_at_ms != out[0].started_at_ms]
    assert len(rest) == 1 and rest[0].duration_s <= 1.3
    assert seg.open_started_at_ms == rest[0].started_at_ms


def test_no_partial_between_lines():
    seg = Segmenter()
    run(seg, frames(2, 0.001))
    assert seg.take_partial(0.1) is None and seg.open_started_at_ms is None


# ------------------------------------------------------------------ main source


def test_share_audio_wins_then_loudest_then_whoever_is_mid_line():
    assert main_source(["a", "b"], ["b", "a#share"]) == "a#share"
    assert main_source(["b", "a"], ["a", "b"]) == "b"
    assert main_source([], ["c"]) == "c"
    assert main_source(["a"], []) is None


# ------------------------------------------------------------------ captioner


def cfg(**kw):
    base = dict(api_url="http://api", secret="x" * 40)
    base.update(kw)
    return Config(**base)


def utt(start=NOW - 2000, seconds=1.0):
    return Utterance(audio=np.zeros(int(SR * seconds), np.float32), started_at_ms=start, voiced_s=seconds)


class Room:
    def __init__(self, ok=True):
        self.packets = []
        self.ok = ok

    def publish(self, packet):
        self.packets.append(packet)
        return self.ok


def make(level=Level.NORMAL, shown=True, room=None, spool=None, edge=False, **cfgkw):
    state = {"level": level, "shown": shown, "now": NOW}
    api = FakeApi()
    api.edge = edge
    live, fb, part = FakeTranscriber("small"), FakeTranscriber("base"), FakeTranscriber("partial", text="namaste")
    room = Room() if room is None else room
    c = LiveCaptioner(
        cfg(**cfgkw), api, "webinar_abc", live, fb, lambda: state["level"], spool, clock_ms=lambda: state["now"],
        partial=part, publish=room.publish if room is not False else None, display=lambda: state["shown"],
    )
    return c, api, room, live, part, state


def test_final_is_published_to_the_room_then_posted_as_published():
    c, api, room, live, _, _ = make()
    c.add("user_1", "Asha", utt())
    assert c.process_next() == "namaste doston"
    assert len(room.packets) == 1
    pkt = room.packets[0]
    assert pkt["kind"] == "caption" and pkt["text"] == "namaste doston" and "partial" not in pkt
    assert pkt["from"] == {"identity": "user_1", "name": "Asha", "role": "panelist"}
    assert pkt["id"] == f"user_1:{NOW - 2000}" and pkt["endedAt"] == NOW - 1000 and pkt["lagMs"] == 1000
    assert api.lines == [dict(identity="user_1", text="namaste doston", started=NOW - 2000, ended=NOW - 1000,
                              partial=False, published=True)]


def test_unknown_switch_leaves_the_relay_to_the_api():
    c, api, room, *_ = make(shown=None)
    c.add("user_1", "A", utt())
    assert c.process_next() == "namaste doston"
    assert room.packets == [] and api.lines[0]["published"] is False


def test_hidden_captions_are_still_posted_for_the_ai_but_never_published():
    c, api, room, *_ = make(shown=False)
    c.add("user_1", "A", utt())
    c.process_next()
    assert room.packets == []
    assert api.captions and api.lines[0]["published"] is False


def test_a_failed_publish_falls_back_to_the_relay():
    c, api, room, *_ = make(room=Room(ok=False))
    c.add("user_1", "A", utt())
    c.process_next()
    assert api.lines[0]["published"] is False


def test_direct_publish_can_be_switched_off():
    c, api, room, *_ = make(direct_publish=False)
    c.add("user_1", "A", utt())
    c.process_next()
    assert room.packets == [] and api.lines[0]["published"] is False


def test_post_runs_through_post_async():
    jobs = []
    c, api, room, *_ = make()
    c.post_async = jobs.append
    c.add("user_1", "A", utt())
    assert c.process_next() == "namaste doston"
    assert room.packets and not api.lines  # on the room before the POST has even started
    jobs[0]()
    assert api.lines


def test_partial_is_published_as_partial_and_never_stored_or_spooled(tmp_path):
    sp = RoomSpool(tmp_path, "webinar_abc", "AJ_1", 10**9)
    c, api, room, live, part, _ = make(spool=sp)
    assert c.offer_partial("user_1", "Asha", utt(seconds=1.2))
    p = c.next_partial()
    assert c.process_partial(p) == "namaste"
    assert room.packets[0]["partial"] is True and room.packets[0]["id"] == f"user_1:{NOW - 2000}"
    assert part.calls and not live.calls  # the cheaper model
    assert api.captions == [] and api.lines == []  # not an edge room: no POST
    assert read_index(sp.dir) == {}


def test_partials_reach_the_api_only_for_an_edge_room():
    c, api, room, *_ = make(edge=True)
    c.report()  # the status answer says edge
    assert c.edge
    c.offer_partial("user_1", "A", utt())
    c.process_partial(c.next_partial())
    assert api.lines == [dict(identity="user_1", text="namaste", started=NOW - 2000, ended=NOW - 1000,
                              partial=True, published=True)]
    assert api.captions == []  # a partial is never a transcript line


@pytest.mark.parametrize("level", [Level.DEGRADED, Level.PAUSED])
def test_no_partials_unless_normal(level):
    c, api, room, _, part, state = make(level=level)
    assert not c.offer_partial("user_1", "A", utt())
    assert c.next_partial() is None and not part.calls


def test_degrading_after_the_offer_drops_the_partial():
    c, api, room, _, part, state = make()
    assert c.offer_partial("user_1", "A", utt())
    state["level"] = Level.DEGRADED
    assert c.next_partial() is None
    assert not part.calls


def test_no_partials_while_captions_are_hidden_or_unknown():
    for shown in (False, None):
        c, *_ = make(shown=shown)
        assert not c.offer_partial("user_1", "A", utt())


def test_no_partials_when_switched_off():
    c, *_ = make(partials=False)
    assert not c.offer_partial("user_1", "A", utt())


def test_finals_go_first_and_a_partial_waits():
    c, api, room, *_ = make()
    c.offer_partial("user_1", "A", utt(start=NOW - 900))
    c.add("user_2", "B", utt())
    assert c.next_partial() is None  # a final is waiting
    assert c.process_next() == "namaste doston"
    p = c.next_partial()
    assert p is not None and p.identity == "user_1"


def test_a_newer_partial_replaces_the_waiting_one():
    c, *_ = make()
    c.offer_partial("user_1", "A", utt(seconds=1.0))
    c.offer_partial("user_1", "A", utt(seconds=2.0))
    assert c.next_partial().utterance.duration_s == 2.0
    assert c.next_partial() is None


def test_a_partial_of_a_finalised_line_is_dropped():
    c, api, room, *_ = make()
    line = utt(start=NOW - 3000, seconds=2.0)
    c.offer_partial("user_1", "A", utt(start=NOW - 3000, seconds=1.0))
    c.add("user_1", "A", line)
    c.process_next()
    assert c.partial is None and c.next_partial() is None
    assert not c.offer_partial("user_1", "A", utt(start=NOW - 3000, seconds=1.5))


def test_a_stale_partial_is_dropped():
    c, _, _, _, part, state = make()
    c.offer_partial("user_1", "A", utt())
    state["now"] += PARTIAL_STALE_MS + 1
    assert c.next_partial() is None


def test_partial_keeps_the_speakers_language_and_does_not_change_it():
    c, api, room, live, part, _ = make()
    c.add("user_1", "A", utt(start=NOW - 5000))
    c.process_next()  # detected: hi
    part.language = "en"
    c.offer_partial("user_1", "A", utt())
    c.process_partial(c.next_partial())
    assert part.calls[-1]["language"] == "hi"
    assert c.languages["user_1"] == "hi"


def test_latency_is_measured():
    c, api, room, *_ = make()
    c.add("user_1", "A", utt(start=NOW - 3000, seconds=2.0))
    c.process_next()
    assert c.stats.values("e2e") == [1000.0]  # the fake clock: the line ended 1 s ago
    assert c.stats.values("queue") == [1000.0]
    assert c.stats.values("decode") == [0.0]
    assert c.stats.values("post") == [0.0]


def test_stats_log_once_per_period():
    t = {"now": 0.0}
    s = LatencyStats("webinar_x", every_s=60, clock_s=lambda: t["now"])
    s.record("e2e", 900)
    s.record("e2e", 1500)
    s.count("finals")
    assert s.maybe_log() is None
    t["now"] = 61
    line = s.maybe_log()
    assert "finals 1" in line and "e2e p50" in line
    t["now"] = 200
    assert s.maybe_log() is None  # nothing new
    assert percentile([1, 2, 3, 4, 5], 0.9) == 5


# ------------------------------------------------------------------ payloads


def test_caption_payload_with_timing_flags():
    p = caption_payload("r", "u", "hi there", 1000, ended_at_ms=2500, partial=True, published=True)
    assert p == {"room": "r", "identity": "u", "text": "hi there", "startedAt": 1000, "endedAt": 2500,
                 "id": "u:1000", "partial": True, "published": True}


def test_caption_packet_shape():
    pkt = caption_packet({"identity": "u", "name": "N", "role": "host"}, " a  b ", 1000, 2000, 2300, partial=False)
    assert pkt == {"kind": "caption", "from": {"identity": "u", "name": "N", "role": "host"}, "text": "a b",
                   "id": "u:1000", "startedAt": 1000, "endedAt": 2000, "lagMs": 300}
    assert len(json.dumps(caption_packet({"identity": "u", "name": "N", "role": "host"}, "x" * 999, 0, 0, 0))) < 600


def test_sender_role_from_participant_metadata():
    assert sender_for("u", "Asha", json.dumps({"role": "host"}))["role"] == "host"
    assert sender_for("u", "", "not json") == {"identity": "u", "name": "Speaker", "role": "panelist"}


def test_captions_shown_from_room_metadata():
    assert captions_shown(json.dumps({"controls": {"captionsEnabled": True}, "status": "live"})) is True
    assert captions_shown(json.dumps({"controls": {"captionsEnabled": False}, "status": "live"})) is False
    assert captions_shown(json.dumps({"controls": {"captionsEnabled": True}, "status": "ended"})) is False
    assert captions_shown("") is None
    assert captions_shown("{") is None
    assert captions_shown(json.dumps({"controls": {}})) is None


def test_config_defaults_and_env():
    c = Config.from_env({"CAPTIONS_API_URL": "https://x", "CAPTIONS_SECRET": "s" * 40})
    assert (c.silence_end_s, c.max_utterance_s, c.soft_utterance_s) == (0.45, 5.0, 3.0)
    assert c.partials and c.partial_model_name == "base" and c.direct_publish
    c = Config.from_env({"CAPTIONS_API_URL": "https://x", "CAPTIONS_SECRET": "s" * 40, "CAPTIONS_PARTIALS": "false",
                         "CAPTIONS_PARTIAL_MODEL": "small", "CAPTIONS_DIRECT_PUBLISH": "0"})
    assert not c.partials and c.partial_model_name == "small" and not c.direct_publish


# ------------------------------------------------------------------ language detection


class _FakeWhisper:
    """faster-whisper's WhisperModel, as far as WhisperTranscriber uses it."""

    def __init__(self, lang):
        self.lang = lang
        self.detects = 0
        self.languages = []

    def detect_language(self, audio=None, language_detection_segments=1):
        self.detects += 1
        return self.lang, 0.9, [(self.lang, 0.9), ("en" if self.lang != "en" else "hi", 0.1)]

    def transcribe(self, audio, language=None, **kw):
        self.languages.append(language)
        return iter([]), None


def test_language_is_detected_by_the_cheaper_model():
    from webcaptions.transcriber import WhisperTranscriber

    base = WhisperTranscriber("base", 2, "/nowhere")
    base._model = _FakeWhisper("hi")
    small = WhisperTranscriber("small", 2, "/nowhere", detector=base)
    small._model = _FakeWhisper("en")
    res = small.transcribe(np.zeros(SR, np.float32), language=None)
    assert res.language == "hi" and base._model.detects == 1 and small._model.detects == 0
    assert small._model.languages == ["hi"]
    # A known language is never detected; the final pass detects with its own model.
    small.transcribe(np.zeros(SR, np.float32), language="en")
    small.transcribe(np.zeros(SR, np.float32), language=None, final=True)
    assert base._model.detects == 1 and small._model.detects == 1


def test_detect_model_defaults_to_the_fallback():
    c = Config.from_env({"CAPTIONS_API_URL": "https://x", "CAPTIONS_SECRET": "s" * 40})
    assert c.detect_model_name == "base"
    c = Config.from_env({"CAPTIONS_API_URL": "https://x", "CAPTIONS_SECRET": "s" * 40, "CAPTIONS_DETECT_MODEL": "small"})
    assert c.detect_model_name == "small"


# ------------------------------------------------------------------ keep-alive


class _KeepAlive(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    connections: set = set()

    def do_POST(self):
        type(self).connections.add(self.client_address)
        self.rfile.read(int(self.headers["Content-Length"]))
        body = b'{"status":"ok","edge":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_client_keeps_the_connection_alive_and_reads_the_answer():
    _KeepAlive.connections = set()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _KeepAlive)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        client = ApiClient(f"http://127.0.0.1:{srv.server_port}", "s" * 40, timeout=5)
        for i in range(3):
            status, body = client.caption_line("webinar_a", "u", f"line {i}", 1000, 2000)
            assert status == 200 and body["edge"] is True
        assert len(_KeepAlive.connections) == 1
    finally:
        srv.shutdown()


def test_client_reconnects_when_the_server_dropped_the_idle_connection():
    _KeepAlive.connections = set()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _KeepAlive)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        client = ApiClient(f"http://127.0.0.1:{srv.server_port}", "s" * 40, timeout=5)
        assert client.status("webinar_a", "live") == 200
        client._local.conn.sock.close()  # as an idle timeout on the far side would
        assert client.status("webinar_a", "live") == 200
    finally:
        srv.shutdown()
