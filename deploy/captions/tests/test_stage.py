"""The video box worker (stage.py) with a fake VAD and a fake Deepgram socket: who is heard,
when a socket is open, and the finals as the session transcript."""

import asyncio
import json
import os

from fakes import FakeApi
from test_provider import NOW, FakeSocket, cfg, result
from webcaptions.provider import CostStats, DeepgramStream, FailoverTracker, SpeechGate
from webcaptions.stage import RoomTranscript, SpeakerTrack, is_stage, post_transcript

FRAME = b"\0\0" * 160  # 10 ms of 16 kHz linear16


class ScriptedVad:
    """Returns the scripted probability for each pushed frame (one 10 ms frame per push)."""

    def __init__(self, probs):
        self.probs = list(probs)
        self.pushed = 0

    def push(self, samples):
        self.pushed += 1
        return self.probs.pop(0) if self.probs else 0.0


def speaker(probs, socks, hangover_s=1.0, events=None):
    calls = []

    async def connect(url, headers):
        calls.append(url)
        return socks.pop(0)

    cost = CostStats("webinar_abc")
    stream = DeepgramStream(cfg(), "user_1", connect, lambda *e: (events if events is not None else []).append(e),
                            FailoverTracker(), cost)
    vad = ScriptedVad(probs)
    gate = SpeechGate(preroll_ms=300, hangover_s=hangover_s, end_silence_ms=500, min_speech_ms=30)
    return SpeakerTrack("user_1", vad, gate, stream), calls, cost, vad


async def feed(sp, n, start=0, muted=False):
    for i in range(start, start + n):
        await sp.frame(FRAME, NOW + i * 10, muted=muted)
        await asyncio.sleep(0)


def test_stage_is_host_and_panelists_never_attendees():
    assert is_stage(json.dumps({"role": "host"}), True)
    assert is_stage(json.dumps({"role": "panelist", "coHost": True}), True)
    assert is_stage(json.dumps({"role": "panelist", "promoted": True}), True)
    assert not is_stage(json.dumps({"role": "attendee"}), True)  # even if somehow allowed to publish
    assert is_stage(None, True) and not is_stage("not json", False)


def test_silence_never_opens_a_socket():
    sp, calls, cost, _ = speaker([0.0] * 300, [])
    asyncio.run(feed(sp, 300))
    assert calls == [] and cost.opens == 0 and cost.audio_ms == 0


def test_speech_opens_with_the_preroll_and_closes_after_the_hangover():
    sock = FakeSocket()
    # 1 s quiet, 1 s speech, 2 s quiet (end silence 0.5 s + 1 s hangover).
    sp, calls, cost, _ = speaker([0.0] * 100 + [0.9] * 100 + [0.0] * 200, [sock], hangover_s=1.0)

    async def scenario():
        await feed(sp, 400)
        await asyncio.sleep(0.01)

    asyncio.run(scenario())
    assert len(calls) == 1 and cost.opens == 1 and cost.closes == 1
    # Sent: the 300 ms pre-roll (its last frame the one that confirmed speech), the rest of
    # the speech, and the 0.5 s of silence that ended it; never the quiet that followed.
    assert len(sock.sent) == 30 + 97 + 50
    assert cost.audio_ms == len(sock.sent) * 10
    assert '{"type":"Finalize"}' in sock.text and '{"type":"CloseStream"}' in sock.text and sock.closed
    assert sp.stream.ws is None


def test_muted_means_no_connection_and_no_vad():
    sp, calls, cost, vad = speaker([0.9] * 200, [])
    asyncio.run(feed(sp, 200, muted=True))
    assert calls == [] and vad.pushed == 0


def test_mute_mid_speech_closes_now_not_after_the_hangover():
    sock = FakeSocket()
    sp, calls, cost, _ = speaker([0.9] * 100, [sock], hangover_s=9.0)

    async def scenario():
        await feed(sp, 50)
        await asyncio.sleep(0.01)
        await feed(sp, 1, start=50, muted=True)
        await asyncio.sleep(0.01)

    asyncio.run(scenario())
    assert cost.opens == 1 and cost.closes == 1 and sock.closed


def test_a_deepgram_room_end_posts_the_finals_as_a_complete_transcript_with_nothing_on_disk(tmp_path, monkeypatch):
    sock = FakeSocket()
    transcript = RoomTranscript()
    events = []
    sp, _, _, _ = speaker([0.9] * 100 + [0.0] * 60, [sock], events=events)
    before = set(os.listdir(tmp_path))
    monkeypatch.chdir(tmp_path)

    async def scenario():
        await feed(sp, 100)
        await asyncio.sleep(0.01)
        sock.inbox.put_nowait(result("hello every", 0.0, 0.5, False))
        sock.inbox.put_nowait(result("Hello, everyone.", 0.0, 0.9, True))
        sock.inbox.put_nowait(result("Welcome.", 0.9, 0.4, True))
        await asyncio.sleep(0.01)
        await sp.stop()

    asyncio.run(scenario())
    for kind, start, end, text in events:
        if kind == "final":
            transcript.add("user_1", "Asha", start, end, text)
    transcript.add("user_1", "Asha", events[1][1], events[1][2], "Hello, everyone.")  # a replay: kept once
    api = FakeApi()
    assert post_transcript(api, "webinar_abc", "deepgram/nova-3", transcript, skip=False) == 201
    (room, model, lines), = api.transcripts
    assert (room, model) == ("webinar_abc", "deepgram/nova-3")
    assert [l.text for l in lines] == ["Hello, everyone.", "Welcome."]
    assert lines[0].start_ms < lines[1].start_ms and all(l.name == "Asha" for l in lines)
    assert set(os.listdir(tmp_path)) == before  # no spool, no audio file anywhere


def test_an_empty_room_still_posts_so_the_recap_starts_and_a_load_test_posts_nothing():
    api = FakeApi()
    assert post_transcript(api, "webinar_abc", "deepgram/nova-3", RoomTranscript(), skip=False) == 201
    assert api.transcripts == [("webinar_abc", "deepgram/nova-3", [])]
    load = FakeApi()
    assert post_transcript(load, "webinar_load", "deepgram/nova-3", RoomTranscript(), skip=True) is None
    assert load.transcripts == []
