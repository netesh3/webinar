"""A transcriber and an API that need no model and no network."""

from __future__ import annotations

from webcaptions.transcriber import Result, Segment


class FakeTranscriber:
    def __init__(self, name="fake", text="नमस्ते दोस्तों", language="hi", segments=None):
        self.name = name
        self.text = text
        self.language = language
        self.segments = segments
        self.calls = []

    def transcribe(self, audio, language=None, previous_language=None, final=False):
        self.calls.append({"n": len(audio), "language": language, "previous": previous_language, "final": final})
        segs = self.segments
        if segs is None:
            segs = [Segment(0.0, len(audio) / 16000, self.text)]
        return Result(text=" ".join(s.text for s in segs), language=language or self.language, segments=list(segs))


class FakeApi:
    def __init__(self, caption_status=200, transcript_status=201):
        self.captions = []
        self.statuses = []
        self.transcripts = []
        self.caption_status = caption_status
        self.transcript_status = transcript_status

    def caption(self, room, identity, text, started_at_ms):
        self.captions.append((room, identity, text, started_at_ms))
        return self.caption_status

    def status(self, room, state):
        self.statuses.append((room, state))
        return 200

    def transcript(self, room, model, lines):
        self.transcripts.append((room, model, list(lines)))
        return self.transcript_status
