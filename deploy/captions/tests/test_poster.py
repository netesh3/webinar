import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from webcaptions.poster import USER_AGENT, ApiClient, TranscriptLine, caption_payload, status_payload, transcript_payload

SECRET = "s" * 40


def test_caption_payload_matches_the_api_contract():
    p = caption_payload("webinar_abc", "user_1", "  hello \n  world  ", 1_700_000_000_123)
    # The exact field names handleInternalCaption reads.
    assert p == {"room": "webinar_abc", "identity": "user_1", "text": "hello world", "startedAt": 1_700_000_000_123}


def test_caption_payload_caps_at_280():
    assert len(caption_payload("r", "i", "x" * 500, 0)["text"]) == 280


def test_status_payload_rejects_unknown_states():
    assert status_payload("r", "live") == {"room": "r", "state": "live"}
    with pytest.raises(ValueError):
        status_payload("r", "sleeping")


def test_transcript_payload_sorted_and_without_blanks():
    lines = [
        TranscriptLine("b", "Ravi", 5000, 6000, "second"),
        TranscriptLine("a", "Asha", 1000, 900, "first"),
        TranscriptLine("a", "Asha", 7000, 8000, "   "),
    ]
    p = transcript_payload("webinar_x", "large-v3-turbo", lines)
    assert p["room"] == "webinar_x" and p["model"] == "large-v3-turbo"
    assert p["segments"] == [
        {"identity": "a", "name": "Asha", "start": 1000, "end": 1000, "text": "first"},
        {"identity": "b", "name": "Ravi", "start": 5000, "end": 6000, "text": "second"},
    ]


class _Recorder(BaseHTTPRequestHandler):
    calls: list = []
    agents: list = []
    statuses: list = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        type(self).calls.append((self.path, self.headers.get("X-Captions-Secret"), json.loads(body)))
        type(self).agents.append(self.headers.get("User-Agent"))
        status = type(self).statuses.pop(0) if type(self).statuses else 200
        self.send_response(status)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


@pytest.fixture
def api():
    _Recorder.calls = []
    _Recorder.agents = []
    _Recorder.statuses = []
    srv = HTTPServer(("127.0.0.1", 0), _Recorder)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield ApiClient(f"http://127.0.0.1:{srv.server_port}/", SECRET, timeout=5), _Recorder
    srv.shutdown()


def test_client_sends_secret_header_and_json(api):
    client, rec = api
    assert client.caption("webinar_a", "user_1", "héllo — café", 42) == 200
    path, secret, body = rec.calls[0]
    assert path == "/api/internal/captions"
    assert secret == SECRET
    assert body["text"] == "héllo — café"  # UTF-8, not escaped away
    # Not urllib's default: Cloudflare answers "Python-urllib/3.x" with a 403.
    assert rec.agents[0] == USER_AGENT and "urllib" not in rec.agents[0].lower()


def test_client_returns_4xx_without_retrying(api):
    client, rec = api
    rec.statuses = [409]
    assert client.caption("webinar_a", "user_1", "late", 0) == 409
    assert len(rec.calls) == 1


def test_client_retries_5xx(api, monkeypatch):
    monkeypatch.setattr("webcaptions.poster.time.sleep", lambda s: None)
    client, rec = api
    rec.statuses = [502, 503, 201]
    assert client.transcript("webinar_a", "m", [TranscriptLine("a", "A", 0, 1, "x")]) == 201
    assert len(rec.calls) == 3
    assert rec.calls[0][0] == "/api/internal/transcripts"


def test_client_unreachable_returns_zero(monkeypatch):
    monkeypatch.setattr("webcaptions.poster.time.sleep", lambda s: None)
    client = ApiClient("http://127.0.0.1:9", SECRET, timeout=0.5)
    assert client.status("webinar_a", "live") == 0
