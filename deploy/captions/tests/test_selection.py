from webcaptions.selection import SpeakerSelector


def make(n=2, linger=3.0):
    return SpeakerSelector(max_speakers=n, linger_s=linger, clock=lambda: 0.0)


def test_never_more_than_n_active_speakers():
    s = make(2)
    assert s.update(["a", "b", "c", "d"], now=0) == {"a", "b"}
    # However large the room, the selection stays at N.
    for t in range(1, 60):
        chosen = s.update([f"p{i}" for i in range(50)], now=t)
        assert len(chosen) <= 2


def test_loudest_first_gets_the_free_slot():
    s = make(1)
    assert s.update(["loud", "quiet"], now=0) == {"loud"}


def test_silence_means_nobody_after_linger():
    s = make(2, linger=3)
    s.update(["a"], now=0)
    assert s.update([], now=2) == {"a"}  # pause for breath: still selected
    assert s.update([], now=3.5) == set()


def test_talking_speaker_is_never_evicted():
    s = make(2)
    s.update(["a", "b"], now=0)
    # c starts while a and b are both still talking: c waits.
    assert s.update(["a", "b", "c"], now=1) == {"a", "b"}


def test_quiet_slot_goes_to_new_speaker():
    s = make(2, linger=10)
    s.update(["a", "b"], now=0)
    s.update(["b"], now=1)  # a goes quiet (lingering)
    assert s.update(["b", "c"], now=2) == {"b", "c"}


def test_longest_quiet_is_evicted_first():
    s = make(2, linger=10)
    s.update(["a", "b"], now=0)
    s.update(["b"], now=1)  # a quiet since 0
    s.update([], now=2)  # b quiet since 1
    assert s.update(["c"], now=3) == {"b", "c"}


def test_lowering_the_limit_keeps_the_active_one():
    s = make(2, linger=10)
    s.update(["a", "b"], now=0)
    s.update(["b"], now=1)
    s.max_speakers = 1
    assert s.selected == {"b"}


def test_remove_frees_the_slot():
    s = make(1)
    s.update(["a"], now=0)
    s.remove("a")
    assert s.update(["b"], now=1) == {"b"}


def test_duplicates_and_blanks_ignored():
    s = make(2)
    assert s.update(["a", "a", "", "b"], now=0) == {"a", "b"}
