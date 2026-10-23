import threading

import numpy as np

from fakes import FakeApi, FakeTranscriber
from webcaptions import spool
from webcaptions.config import Config
from webcaptions.finalizer import Finalizer, build_chunks, chunk_time_to_wall, transcribe_room
from webcaptions.transcriber import Segment

SR = 16000


def cfg(tmp_path, **kw):
    base = dict(api_url="http://api", secret="x" * 40, spool_dir=str(tmp_path))
    base.update(kw)
    return Config(**base)


def entry(start_ms, seconds, offset=0, identity="user_1"):
    return spool.IndexEntry(offset=offset, samples=int(seconds * SR), start_ms=start_ms, identity=identity, name="Asha")


def test_chunks_join_close_utterances_up_to_thirty_seconds():
    es = [entry(0, 5), entry(5500, 5), entry(11000, 5), entry(60_000, 5)]
    chunks = build_chunks(es)
    assert [len(c) for c in chunks] == [3, 1]  # the 44 s gap starts a new window
    many = [entry(i * 6000, 5.9) for i in range(10)]
    assert all(sum(e.samples for e in c) <= 30 * SR for c in build_chunks(many))


def test_chunk_time_maps_back_to_the_wall_clock():
    pieces = [entry(10_000, 2.0), entry(20_000, 3.0)]
    assert chunk_time_to_wall(pieces, 0.0) == 10_000
    assert chunk_time_to_wall(pieces, 1.5) == 11_500
    # 2.5 s into the concatenation is 0.5 s into the second utterance.
    assert chunk_time_to_wall(pieces, 2.5) == 20_500
    assert chunk_time_to_wall(pieces, 99) == 23_000  # clamped to the end


def write_room(tmp_path):
    sp = spool.RoomSpool(tmp_path, "webinar_abc", "AJ_1", 10**9)
    sp.write("user_1", "Asha", np.full(2 * SR, 0.1, np.float32), 1_000_000)
    sp.write("user_2", "Ravi", np.full(1 * SR, 0.1, np.float32), 1_001_000)
    sp.write("user_1", "Asha", np.full(1 * SR, 0.1, np.float32), 1_002_500)
    return sp


def test_transcribe_room_interleaves_speakers_with_timestamps(tmp_path):
    sp = write_room(tmp_path)
    t = FakeTranscriber("large-v3-turbo", segments=[Segment(0.0, 0.8, "thanks"), Segment(2.2, 2.9, "ok")])
    lines = transcribe_room(sp.dir, t, "native", "en")
    assert all(call["final"] for call in t.calls)
    assert [(l.identity, l.start_ms, l.text) for l in lines] == [
        ("user_1", 1_000_000, "thanks"),
        ("user_2", 1_001_000, "thanks"),
        # Ravi's audio is only 1 s long, so a segment past its end is clamped to the end.
        ("user_2", 1_002_000, "ok"),
        # 2.2 s into Asha's chunk is 0.2 s into her second utterance.
        ("user_1", 1_002_700, "ok"),
    ]
    assert all(l.name for l in lines)


def test_finalizer_posts_then_deletes_the_audio(tmp_path):
    sp = write_room(tmp_path)
    sp.mark_done()
    api = FakeApi()
    fin = Finalizer(cfg(tmp_path), api, FakeTranscriber("large-v3-turbo"), wait_until_idle=lambda stop: True)
    assert fin.run_once() == 1
    room, model, lines = api.transcripts[0]
    assert room == "webinar_abc" and model == "large-v3-turbo"
    assert {l.identity for l in lines} == {"user_1", "user_2"}
    assert lines[0].text == "hello everyone"
    assert not sp.dir.exists()


def test_finalizer_keeps_audio_for_a_retry_on_server_error(tmp_path):
    sp = write_room(tmp_path)
    sp.mark_done()
    api = FakeApi(transcript_status=502)
    fin = Finalizer(cfg(tmp_path), api, FakeTranscriber(), wait_until_idle=lambda stop: True)
    assert fin.run_once() == 0
    assert sp.dir.exists()
    assert spool.read_manifest(sp.dir)["attempts"] == 1
    for _ in range(4):
        fin.run_once()
    assert not sp.dir.exists()  # gave up after five


def test_finalizer_ignores_rooms_still_running(tmp_path):
    sp = write_room(tmp_path)  # not marked done
    api = FakeApi()
    fin = Finalizer(cfg(tmp_path), api, FakeTranscriber(), wait_until_idle=lambda stop: True)
    assert fin.run_once() == 0
    assert sp.dir.exists() and not api.transcripts
    assert spool.live_rooms(tmp_path) == 1
    assert spool.close_orphans(tmp_path) == 1
    assert spool.live_rooms(tmp_path) == 0


def test_finalizer_waits_for_an_idle_host(tmp_path):
    sp = write_room(tmp_path)
    sp.mark_done()
    api = FakeApi()
    fin = Finalizer(cfg(tmp_path), api, FakeTranscriber(), wait_until_idle=lambda stop: False)
    assert fin.run_once() == 0
    assert sp.dir.exists() and not api.transcripts


def test_room_where_nobody_spoke_posts_an_empty_transcript(tmp_path):
    # The API's recap waits for this post; without it a silent session sat "processing"
    # for the whole 30-minute wait (instant-webinar-0273).
    sp = spool.RoomSpool(tmp_path, "webinar_quiet", "AJ_2", 10**9)
    sp.mark_done()
    api = FakeApi()
    t = FakeTranscriber("large-v3-turbo")
    fin = Finalizer(cfg(tmp_path), api, t, wait_until_idle=lambda stop: True)
    assert fin.run_once() == 1
    assert api.transcripts == [("webinar_quiet", "large-v3-turbo", [])]
    assert not t.calls and not sp.dir.exists()


def test_empty_transcript_is_kept_for_a_retry_on_server_error(tmp_path):
    sp = spool.RoomSpool(tmp_path, "webinar_quiet", "AJ_2", 10**9)
    sp.mark_done()
    fin = Finalizer(cfg(tmp_path), FakeApi(transcript_status=503), FakeTranscriber(), wait_until_idle=lambda stop: True)
    assert fin.run_once() == 0
    assert sp.dir.exists() and spool.read_manifest(sp.dir)["attempts"] == 1


def test_resume_takes_up_rooms_a_replaced_container_left(tmp_path):
    # A deploy replaced the container: one room was cut off mid-session (never marked done),
    # another had ended and was waiting for its final pass. Both are on the spool volume.
    cut = write_room(tmp_path)
    waiting = spool.RoomSpool(tmp_path, "webinar_other", "AJ_9", 10**9)
    waiting.write("user_3", "Mira", np.full(SR, 0.1, np.float32), 2_000_000)
    waiting.mark_done()

    # A new container: a fresh Finalizer over the same directory.
    api = FakeApi()
    fin = Finalizer(cfg(tmp_path), api, FakeTranscriber(), wait_until_idle=lambda stop: True)
    assert fin.resume() == 2
    assert spool.live_rooms(tmp_path) == 0  # the cut-off room no longer blocks the pass
    assert fin.run_once() == 2
    assert sorted(r for r, _, _ in api.transcripts) == ["webinar_abc", "webinar_other"]
    assert not cut.dir.exists() and not waiting.dir.exists()
    # Idempotent: nothing is posted twice.
    assert fin.resume() == 0 and fin.run_once() == 0 and len(api.transcripts) == 2


def test_resume_after_a_kill_mid_pass_posts_once(tmp_path):
    # Killed while transcribing (wait_ok said stop): the audio stays, and the next start posts it.
    sp = write_room(tmp_path)
    sp.mark_done()
    api = FakeApi()
    first = Finalizer(cfg(tmp_path), api, FakeTranscriber(), wait_until_idle=lambda stop: False)
    assert first.run_once() == 0 and sp.dir.exists() and not api.transcripts
    second = Finalizer(cfg(tmp_path), api, FakeTranscriber(), wait_until_idle=lambda stop: True)
    assert second.resume() == 1
    assert second.run_once() == 1 and len(api.transcripts) == 1 and not sp.dir.exists()


def test_spool_respects_its_size_cap(tmp_path):
    sp = spool.RoomSpool(tmp_path, "webinar_cap", "AJ_3", max_bytes=SR * 2)  # one second
    assert sp.write("u", "U", np.zeros(SR, np.float32), 0)
    assert not sp.write("u", "U", np.zeros(SR, np.float32), 1000)
