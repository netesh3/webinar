import numpy as np

from webcaptions.segmenter import Segmenter, pcm16_to_float, rms

SR = 16000
FRAME = 320  # 20 ms


def frames(seconds, amplitude):
    n = int(seconds * SR / FRAME)
    rng = np.random.default_rng(0)
    for _ in range(n):
        yield (rng.standard_normal(FRAME) * amplitude).astype(np.float32)


def run(seg, chunks, t0=1_000_000):
    out, t = [], t0
    for f in chunks:
        t += 20
        out.extend(seg.push(f, t))
    return out, t


def test_silence_produces_nothing():
    seg = Segmenter()
    out, _ = run(seg, frames(10, 0.001))
    assert out == [] and not seg.in_speech


def test_speech_then_pause_is_one_utterance():
    seg = Segmenter(silence_end_s=0.6)
    chunks = list(frames(0.5, 0.001)) + list(frames(2.0, 0.2)) + list(frames(1.0, 0.001))
    out, _ = run(seg, chunks, t0=1_000_000)
    assert len(out) == 1
    u = out[0]
    assert 2.0 <= u.duration_s <= 2.0 + 0.2 + 0.3 + 0.05
    # Started at the speech (minus the 200 ms pre-roll), on the wall clock.
    assert abs(u.started_at_ms - (1_000_000 + 500 - 200)) <= 40


def test_long_speech_is_cut_at_max():
    seg = Segmenter(max_utterance_s=6.0)
    out, _ = run(seg, frames(13, 0.2))
    assert len(out) == 2
    assert all(u.duration_s <= 6.05 for u in out)


def test_a_click_is_not_an_utterance():
    seg = Segmenter(min_voiced_s=0.3)
    chunks = list(frames(0.1, 0.3)) + list(frames(1.0, 0.0005))
    out, _ = run(seg, chunks)
    assert out == []


def test_flush_closes_open_speech():
    seg = Segmenter()
    run(seg, frames(1.0, 0.2))
    assert len(seg.flush()) == 1
    assert seg.flush() == []


def test_pcm16_conversion_and_rms():
    pcm = (np.ones(100) * 16384).astype("<i2").tobytes()
    f = pcm16_to_float(pcm)
    assert f.dtype == np.float32 and abs(f[0] - 0.5) < 1e-6
    assert abs(rms(f) - 0.5) < 1e-6
