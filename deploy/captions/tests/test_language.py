"""The webinar's captions language (api/types/captions_language.go) in the Deepgram worker:
read from the dispatch and room metadata, sent as Deepgram's language, a live change
reconnecting the stream, and no stream at all for a language Deepgram lacks (Malayalam)."""

import asyncio
import json
import urllib.parse

from fakes import FakeApi
from test_provider import NOW, FakeSocket, cfg
from webcaptions.config import deepgram_supports, job_language
from webcaptions.poster import captions_language, session_language, transcript_payload
from webcaptions.provider import DeepgramStream, FailoverTracker, listen_url
from webcaptions.stage import RoomTranscript, post_transcript


def room_meta(lang):
    return json.dumps({"status": "live", "controls": {"captionsEnabled": True, "captionsLanguage": lang}})


def language_of(url):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))["language"]


def test_the_language_comes_from_the_room_then_the_dispatch_then_the_env():
    c = cfg(deepgram_language="multi")
    assert job_language('{"slug":"abc","room":"webinar_abc","language":"ta"}') == "ta"
    assert job_language('{"slug":"abc"}') is None and job_language("not json") is None and job_language(None) is None
    assert captions_language(room_meta("hi")) == "hi"
    assert captions_language('{"controls":{}}') is None and captions_language("") is None
    assert session_language(room_meta("hi"), "ta", c) == "hi"
    assert session_language('{"controls":{"captionsEnabled":true}}', "ta", c) == "ta"
    assert session_language(None, None, c) == "multi"


def test_deepgram_gets_the_webinars_language_and_the_env_is_only_the_fallback():
    assert language_of(listen_url(cfg(deepgram_language="multi"), "en-IN")) == "en-IN"
    assert language_of(listen_url(cfg(deepgram_language="multi"))) == "multi"


def test_malayalam_is_not_a_deepgram_language():
    c = cfg(deepgram_language="multi")
    for code in ("en-IN", "hi", "multi", "ta", "te", "kn", "mr", "bn", "gu"):
        assert deepgram_supports(code, c), code
    assert not deepgram_supports("ml", c)
    assert not deepgram_supports("", c)


def test_an_unsupported_language_opens_no_stream_and_sends_nothing():
    calls = []

    async def connect(url, headers):
        calls.append(url)
        return FakeSocket()

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: None, FailoverTracker(), language=lambda: "ml")
        await s.open()
        for i in range(50):
            await s.send(b"\0" * 320, NOW + i * 10)
        await asyncio.sleep(0.01)
        return s

    s = asyncio.run(scenario())
    assert calls == [] and s.ws is None and len(s._pending) == 0


def test_a_language_change_reconnects_in_the_new_language():
    lang = ["en-IN"]
    socks = [FakeSocket(), FakeSocket()]
    urls = []

    async def connect(url, headers):
        urls.append(url)
        return socks[len(urls) - 1]

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: None, FailoverTracker(), language=lambda: lang[0])
        await s.open()
        await s.send(b"\0" * 320, NOW)
        await asyncio.sleep(0.01)
        first = s.ws
        await s.relanguage()  # unchanged: the socket stays
        assert s.ws is first
        lang[0] = "hi"
        await s.relanguage()
        await asyncio.sleep(0.01)
        return s, first

    s, first = asyncio.run(scenario())
    assert [language_of(u) for u in urls] == ["en-IN", "hi"]
    assert first.closed and '{"type":"CloseStream"}' in first.text  # its last results asked for
    assert s.ws is socks[1] and s.want_open


def test_a_change_to_malayalam_closes_the_stream_and_opens_none():
    lang = ["hi"]
    urls = []

    async def connect(url, headers):
        urls.append(url)
        return FakeSocket()

    async def scenario():
        s = DeepgramStream(cfg(), "user_1", connect, lambda *e: None, FailoverTracker(), language=lambda: lang[0])
        await s.open()
        await asyncio.sleep(0.01)
        lang[0] = "ml"
        await s.relanguage()
        await s.send(b"\0" * 320, NOW)
        await asyncio.sleep(0.01)
        return s

    s = asyncio.run(scenario())
    assert [language_of(u) for u in urls] == ["hi"] and s.ws is None


def test_the_transcript_says_what_language_it_was_captioned_in():
    assert transcript_payload("webinar_abc", "deepgram/nova-3", [], "ta")["language"] == "ta"
    assert "language" not in transcript_payload("webinar_abc", "deepgram/nova-3", [])
    api = FakeApi()
    assert post_transcript(api, "webinar_abc", "deepgram/nova-3", RoomTranscript(), skip=False, language="hi") == 201
    assert api.transcript_languages == ["hi"]
