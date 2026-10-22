import numpy as np

from fakes import FakeApi, FakeTranscriber
from webcaptions.config import Config
from webcaptions.cpuguard import Level
from webcaptions.live import LiveCaptioner
from webcaptions.segmenter import Utterance
from webcaptions.spool import RoomSpool, read_index

NOW = 1_700_000_000_000


def cfg(**kw):
    base = dict(api_url="http://api", secret="x" * 40)
    base.update(kw)
    return Config(**base)


def utt(start=NOW - 2000, seconds=1.0):
    return Utterance(audio=np.zeros(int(16000 * seconds), np.float32), started_at_ms=start, voiced_s=seconds)


def make(level=Level.NORMAL, spool=None, **kw):
    state = {"level": level}
    api = FakeApi(**kw)
    live, fb = FakeTranscriber("small"), FakeTranscriber("base")
    c = LiveCaptioner(cfg(), api, "webinar_abc", live, fb, lambda: state["level"], spool, clock_ms=lambda: NOW)
    return c, api, live, fb, state


def test_posts_roman_caption_for_the_speaker():
    c, api, live, _, _ = make()
    c.add("user_1", "Asha", utt())
    assert c.process_next() == "namaste doston"
    assert api.captions == [("webinar_abc", "user_1", "namaste doston", NOW - 2000)]
    assert live.calls[0]["final"] is False


def test_native_script_keeps_devanagari():
    c, api, _, _, _ = make()
    c.cfg = cfg(script="native")
    c.add("user_1", "Asha", utt())
    c.process_next()
    assert api.captions[0][2] == "नमस्ते दोस्तों"


def test_degraded_uses_fallback_model_and_keeps_only_newest_per_speaker():
    c, api, live, fb, state = make()
    state["level"] = Level.DEGRADED
    c.add("user_1", "A", utt(start=NOW - 3000))
    c.add("user_1", "A", utt(start=NOW - 1500))
    assert len(c.queue) == 1
    c.process_next()
    assert fb.calls and not live.calls


def test_paused_decodes_nothing_but_still_spools(tmp_path):
    sp = RoomSpool(tmp_path, "webinar_abc", "AJ_1", 10**9)
    c, api, live, fb, state = make(level=Level.PAUSED, spool=sp)
    c.add("user_1", "A", utt())
    assert c.process_next() is None
    assert not live.calls and not fb.calls and not api.captions
    idx = read_index(sp.dir)
    assert idx["user_1"][0].samples == 16000


def test_stale_utterances_are_skipped():
    c, api, live, _, _ = make()
    c.add("user_1", "A", utt(start=NOW - 30_000))
    assert c.process_next() is None
    assert not live.calls and c.skipped == 1


def test_409_stops_decoding():
    c, api, live, _, _ = make(caption_status=409)
    c.add("user_1", "A", utt())
    c.process_next()
    assert c.captions_off
    c.add("user_1", "A", utt())
    assert c.process_next() is None
    assert len(live.calls) == 1


def test_language_is_detected_then_reused_per_speaker():
    c, api, live, _, _ = make()
    for _ in range(6):
        c.add("user_1", "A", utt())
        c.process_next()
    # Detected on the first line, reused for three, detected again on the fifth.
    assert [call["language"] for call in live.calls] == [None, "hi", "hi", "hi", None, "hi"]
    assert live.calls[1]["previous"] == "hi"
    # Another speaker gets their own detection.
    c.add("user_2", "B", utt())
    c.process_next()
    assert live.calls[-1]["language"] is None


def test_fixed_language_is_never_detected():
    c, api, live, _, _ = make()
    c.cfg = cfg(language="en")
    c.add("user_1", "A", utt())
    c.process_next()
    assert live.calls[0]["language"] == "en"


def test_report_only_on_change():
    c, api, _, _, state = make()
    assert c.report() == "live"
    assert c.report() is None
    state["level"] = Level.DEGRADED
    assert c.report() is None  # degraded is still live captions
    state["level"] = Level.PAUSED
    assert c.report() == "paused"
    assert c.report(stopped=True) == "stopped"
    assert [s for _, s in api.statuses] == ["live", "paused", "stopped"]


def test_queue_is_bounded():
    c, *_ = make()
    for i in range(20):
        c.add(f"user_{i % 2}", "A", utt())
    assert len(c.queue) <= 6
