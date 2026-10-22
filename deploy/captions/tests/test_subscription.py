"""Who the agent subscribes to, and whose lines reach the model.

Regression: the agent used to subscribe only to the speakers it had selected from LiveKit's
active-speaker updates. LiveKit sends a participant speaker updates only for participants it
is subscribed to (livekit-server ParticipantImpl.SendSpeakerUpdate, IsSubscribedTo), so the
agent never heard of a speaker, never selected one and never subscribed: a host talking
alone in a meeting got no captions ("posted 0", "nobody spoke").
"""

import numpy as np

from fakes import FakeApi, FakeTranscriber
from webcaptions.config import Config
from webcaptions.cpuguard import Level
from webcaptions.live import LiveCaptioner
from webcaptions.segmenter import SAMPLE_RATE, Segmenter
from webcaptions.selection import FrameWatch, LineGate, SpeakerSelector, pipeline_key, wants_key

HOST = "user_31bad936-088d-4dad-9498-449ea075dca3"
FRAME_S = 0.02


class FakeSfu:
    """The one LiveKit behaviour that matters here: speaker updates are scoped to the
    participants the receiver is subscribed to."""

    def __init__(self):
        self.subscribed: set[str] = set()

    def speaker_update(self, speaking: list[str]) -> list[str]:
        return [s for s in speaking if s in self.subscribed]


def frame(amplitude):
    n = int(FRAME_S * SAMPLE_RATE)
    return np.full(n, amplitude, np.float32) * np.sign(np.sin(np.arange(n)))


def run_room(subscribe_all: bool, seconds=12.0, unmute_at=4.0, talk_for=3.0):
    """A host alone in a meeting, mic muted at entry, who unmutes and talks.

    Mirrors agent.py: subscriptions, then per subscribed source a Segmenter whose lines
    pass a LineGate on the selection."""
    sfu = FakeSfu()
    sel = SpeakerSelector(max_speakers=2, linger_s=3.0, clock=lambda: 0.0)
    seg, gate = Segmenter(), LineGate()
    lines = []
    active: list[str] = []
    t = 0.0
    while t < seconds:
        talking = unmute_at <= t < unmute_at + talk_for
        # Speaker updates (LiveKit sends them ~every 300 ms, with some delay).
        if round(t / FRAME_S) % 15 == 0:
            active = sfu.speaker_update([HOST] if talking else [])
        chosen = sel.update(active, now=t)
        if subscribe_all:
            sfu.subscribed.add(HOST)
        else:
            sfu.subscribed = set(chosen)  # the old policy
        # A muted mic sends no frames; an unmuted one does, to subscribers.
        if HOST in sfu.subscribed and t >= unmute_at:
            want = wants_key(pipeline_key(HOST, False), sel.selected)
            for u in seg.push(frame(0.2 if talking else 0.0), int(t * 1000)):
                if gate.take(want):
                    lines.append(u)
            gate.note(want, seg.in_speech)
        t += FRAME_S
    return lines


def test_subscribing_only_to_the_selection_never_hears_anyone():
    # Documents the bug: the selection reads speaker updates the subscription gates.
    assert run_room(subscribe_all=False) == []


def test_host_who_unmutes_after_join_is_captioned():
    lines = run_room(subscribe_all=True)
    assert len(lines) >= 1
    # The line starts when the host started talking, not when LiveKit named them.
    assert lines[0].started_at_ms <= 4000 + 50


def test_a_line_that_opens_before_selection_is_kept():
    g = LineGate()
    g.note(False, True)  # speaking, not selected yet
    g.note(True, True)  # LiveKit names them mid-line
    assert g.take(False)  # kept even if the slot lingered out by the end
    assert not g.take(False)  # and the next line starts fresh


def test_a_line_never_selected_is_dropped_share_always_kept():
    g = LineGate()
    g.note(False, True)
    assert not g.take(False)
    assert wants_key(pipeline_key("user_b", True), set())  # share audio needs no slot
    assert not wants_key("user_b", {"user_a"})
    assert wants_key("user_a", {"user_a"})


def test_frame_watch_warns_once_per_quiet_spell_and_not_while_muted():
    w = FrameWatch(60.0)
    w.start("a", 0.0)
    w.start("b", 0.0)
    assert w.frame("a", 1.0) is True  # first frame
    assert w.frame("a", 2.0) is False
    assert w.due(30.0) == []
    assert w.due(61.0, muted=lambda k: k == "b") == []  # b is muted: not a stall
    assert w.due(62.5) == ["a"]
    assert w.due(70.0) == []  # once
    w.frame("a", 71.0)
    assert w.due(140.0) == ["a", "b"]  # a re-armed by a frame; b quiet since it was muted
    assert w.frames("a") == 3
    w.stop("a")
    assert w.frames("a") == 0


def test_captions_switched_on_mid_session_start_showing():
    """The job joins with captions hidden (shown False) and the host turns them on later:
    the room metadata change must reach the next line."""
    shown = [False]
    published = []
    api = FakeApi()
    c = LiveCaptioner(
        Config(api_url="http://api", secret="x" * 40), api, "webinar_meeting-1105",
        FakeTranscriber("small", text="hello everyone", language="en"), FakeTranscriber("base"),
        lambda: Level.NORMAL, None, publish=lambda p: published.append(p) or True,
        display=lambda: shown[0], sender_of=lambda i, n: {"identity": i, "name": n},
        post_async=lambda fn: fn(), clock_ms=lambda: 1_700_000_000_000,
    )
    from webcaptions.segmenter import Utterance

    def utt(start):
        return Utterance(audio=np.zeros(16000, np.float32), started_at_ms=start, voiced_s=1.0)

    c.add(HOST, "Host", utt(1_700_000_000_000 - 2000))
    c.process_next()
    assert published == []  # hidden: stored, not shown
    shown[0] = True  # room_metadata_changed
    c.add(HOST, "Host", utt(1_700_000_000_000 - 1000))
    c.process_next()
    assert len(published) == 1 and published[0]["kind"] == "caption"
