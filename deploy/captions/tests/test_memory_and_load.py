"""24 Oct 2026: the after-session pass held large-v3-turbo (+1.2 GB) and the container's
whole CPU cap through the next live webinar. These pin the fix: the pass runs in a child
that is stopped when a room goes live, checkpoints every window, and resumes; the worker's
load is its rooms, not the host CPU."""

import sys
import threading
from pathlib import Path

import numpy as np
import pytest

from fakes import FakeApi, FakeTranscriber
from webcaptions import spool
from webcaptions.config import Config, room_load
from webcaptions.cpuguard import OthersCpuSampler
from webcaptions.finalizer import PROGRESS, ChildTranscribe, Finalizer, build_chunks, idle_wait, transcribe_room
from webcaptions.transcriber import Segment

SR = 16000
PKG = str(Path(__file__).resolve().parent.parent)
TESTS = str(Path(__file__).resolve().parent)


def cfg(tmp_path, **kw):
    base = dict(api_url="http://api", secret="x" * 40, spool_dir=str(tmp_path))
    base.update(kw)
    return Config(**base)


def room(tmp_path, windows=3):
    """One speaker, `windows` utterances a minute apart: one window each."""
    sp = spool.RoomSpool(tmp_path, "webinar_abc", "AJ_1", 10**9)
    for i in range(windows):
        sp.write("user_1", "Asha", np.full(SR, 0.1, np.float32), 1_000_000 + i * 60_000)
    sp.mark_done()
    return sp


# ---------------------------------------------------------------- windows


def test_short_pauses_join_one_window():
    # 5 s pauses no longer split windows (each split cost a full padded 30 s decode).
    es = [spool.IndexEntry(0, 2 * SR, i * 7000, "u", "U") for i in range(4)]
    assert [len(c) for c in build_chunks(es)] == [4]
    far = [spool.IndexEntry(0, 2 * SR, i * 20_000, "u", "U") for i in range(3)]
    assert [len(c) for c in build_chunks(far)] == [1, 1, 1]


# ------------------------------------------------------------- checkpoint


def test_checkpoint_skips_windows_already_done(tmp_path):
    sp = room(tmp_path)
    t = FakeTranscriber(segments=[Segment(0.0, 0.5, "hi")])
    calls = {"n": 0}

    def stop_after_two() -> bool:
        calls["n"] += 1
        return calls["n"] <= 2

    assert transcribe_room(sp.dir, t, "native", "en", wait_ok=stop_after_two, checkpoint=True) is None
    assert len(t.calls) == 2 and (sp.dir / PROGRESS).exists()
    # Not a speaker index: the progress file never reads as audio.
    assert set(spool.read_index(sp.dir)) == {"user_1"}

    again = FakeTranscriber(segments=[Segment(0.0, 0.5, "hi")])
    lines = transcribe_room(sp.dir, again, "native", "en", checkpoint=True)
    assert len(again.calls) == 1  # only the window the first run did not finish
    assert [l.start_ms for l in lines] == [1_000_000, 1_060_000, 1_120_000]
    # Everything checkpointed: collecting needs no model at all.
    assert len(transcribe_room(sp.dir, None, "native", "en", checkpoint=True)) == 3


def test_a_torn_checkpoint_line_is_redone(tmp_path):
    sp = room(tmp_path, windows=1)
    (sp.dir / PROGRESS).write_text('{"key": "user_1/0/1000000", "lines": [[', encoding="utf-8")
    t = FakeTranscriber()
    assert len(transcribe_room(sp.dir, t, "native", "en", checkpoint=True)) == 1
    assert len(t.calls) == 1


def test_collecting_an_unfinished_room_fails_loudly(tmp_path):
    sp = room(tmp_path, windows=1)
    with pytest.raises(RuntimeError):
        transcribe_room(sp.dir, None, "native", "en", checkpoint=True)


# ------------------------------------------------------------- the child


CHILD = f"""
import sys
sys.path[:0] = [{PKG!r}, {TESTS!r}]
from pathlib import Path
from fakes import FakeTranscriber
from webcaptions.finalizer import transcribe_room
transcribe_room(Path(sys.argv[1]), FakeTranscriber(), "native", "en", checkpoint=True)
"""


def test_child_pass_is_collected_and_posted(tmp_path):
    sp = room(tmp_path)
    api = FakeApi()
    c = cfg(tmp_path)
    child = ChildTranscribe(busy=lambda: False, cfg=c, poll_s=0.05, argv=[sys.executable, "-c", CHILD])
    fin = Finalizer(c, api, FakeTranscriber("large-v3-turbo"), wait_until_idle=lambda stop: True, transcribe=child)
    assert fin.run_once() == 1
    room_name, model, lines = api.transcripts[0]
    assert room_name == "webinar_abc" and model == "large-v3-turbo" and len(lines) == 3
    assert not sp.dir.exists()


def test_child_is_stopped_when_a_room_goes_live(tmp_path):
    sp = room(tmp_path)
    live = threading.Event()
    waits = {"n": 0}

    def wait_ok() -> bool:
        waits["n"] += 1
        return waits["n"] == 1  # the second call (after the stop) is the container shutting down

    child = ChildTranscribe(
        busy=live.is_set, cfg=cfg(tmp_path), poll_s=0.05,
        argv=[sys.executable, "-c", "import time; time.sleep(60)"],
    )
    threading.Timer(0.3, live.set).start()
    assert child(sp.dir, wait_ok) is None
    assert child.stopped == 1


def test_a_crashing_child_counts_as_an_attempt(tmp_path):
    sp = room(tmp_path)
    c = cfg(tmp_path)
    child = ChildTranscribe(busy=lambda: False, cfg=c, poll_s=0.05, argv=[sys.executable, "-c", "raise SystemExit(9)"])
    fin = Finalizer(c, FakeApi(), FakeTranscriber(), wait_until_idle=lambda stop: True, transcribe=child)
    assert fin.run_once() == 0
    assert spool.read_manifest(sp.dir)["attempts"] == 1
    for _ in range(4):
        fin.run_once()
    assert not sp.dir.exists()  # given up after five, never an endless reload loop


def test_idle_wait_blocks_while_busy_and_honours_stop():
    stop = threading.Event()
    seq = iter([True, True, False])
    assert idle_wait(lambda: next(seq), poll_s=0.01)(stop) is True
    stop.set()
    assert idle_wait(lambda: True, poll_s=0.01)(stop) is False


# ------------------------------------------------------------ cpu sampler


def test_others_sampler_leaves_out_its_own_cpu(tmp_path):
    stat = tmp_path / "stat"
    own = {"s": 0.0}
    s = OthersCpuSampler(str(stat), own_cpu_s=lambda: own["s"], ticks_per_s=100)

    def write(busy, idle):
        stat.write_text(f"cpu  {busy} 0 0 {idle} 0 0 0 0 0 0\n")

    write(0, 0)
    assert s.sample() is None  # primes
    # 2 CPUs for 1 s = 200 ticks; 180 busy, of which our own 1.6 s CPU = 160 ticks.
    write(180, 20)
    own["s"] = 1.6
    assert s.sample() == pytest.approx(10.0)
    # Nobody else busy: never negative.
    write(380, 20)
    own["s"] = 3.8
    assert s.sample() == 0.0


# ---------------------------------------------------------------- load


@pytest.mark.parametrize(
    "jobs,rooms,load",
    [(0, 2, 0.0), (1, 2, 0.5), (2, 2, 1.0), (3, 2, 1.0), (0, 1, 0.0), (1, 1, 1.0), (1, 0, 1.0)],
)
def test_room_load_is_rooms_not_cpu(jobs, rooms, load):
    assert room_load(jobs, rooms) == load
    # agent.py's threshold: a worker with a free room slot is available, a full one is not.
    assert (room_load(jobs, rooms) < 0.99) == (jobs < max(1, rooms))
