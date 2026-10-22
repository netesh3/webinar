"""What the agent sends the API, and how.

Three endpoints, all authenticated by the shared secret in X-Captions-Secret (the API
compares it in constant time; see api/internal/api/server_captions.go):

    POST /api/internal/captions          one finished line, fanned out to the room
    POST /api/internal/captions/status   live | paused | stopped
    POST /api/internal/transcripts       the after-session transcript

Plain urllib, called from a worker thread: three small JSON posts do not justify another
HTTP dependency, and the agent never blocks its event loop on them.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request

# Our own User-Agent, not urllib's. Cloudflare in front of webinarliv.com answers urllib's
# default ("Python-urllib/3.x") with a 403 before the request reaches the API, so on the first
# live test every line and status post was refused while curl from the same box got through.
USER_AGENT = "webinarliv-captions/1.0 (+https://webinarliv.com)"
from dataclasses import dataclass
from typing import Any, Sequence

log = logging.getLogger("captions.poster")

MAX_CAPTION_CHARS = 280  # the API's (and the browser's) cap


def caption_payload(room: str, identity: str, text: str, started_at_ms: int) -> dict[str, Any]:
    text = " ".join((text or "").split())
    return {
        "room": room,
        "identity": identity,
        "text": text[:MAX_CAPTION_CHARS],
        "startedAt": int(started_at_ms),
    }


def status_payload(room: str, state: str) -> dict[str, Any]:
    if state not in ("live", "paused", "stopped"):
        raise ValueError(f"bad caption state {state!r}")
    return {"room": room, "state": state}


@dataclass
class TranscriptLine:
    identity: str
    name: str
    start_ms: int
    end_ms: int
    text: str


def transcript_payload(room: str, model: str, lines: Sequence[TranscriptLine]) -> dict[str, Any]:
    ordered = sorted(lines, key=lambda l: (l.start_ms, l.identity))
    return {
        "room": room,
        "model": model,
        "segments": [
            {
                "identity": l.identity,
                "name": l.name,
                "start": int(l.start_ms),
                "end": int(max(l.end_ms, l.start_ms)),
                "text": l.text,
            }
            for l in ordered
            if l.text.strip()
        ],
    }


class ApiClient:
    def __init__(self, base_url: str, secret: str, timeout: float = 10.0) -> None:
        self._base = base_url.rstrip("/")
        self._secret = secret
        self._timeout = timeout

    def post(self, path: str, payload: dict[str, Any], retries: int = 2) -> int:
        """Returns the HTTP status (0 when the API could not be reached). Retries 5xx and
        network errors with a short backoff; a 4xx is the API's answer and is returned."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        attempt = 0
        while True:
            req = urllib.request.Request(
                self._base + path,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "X-Captions-Secret": self._secret,
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=self._timeout) as res:
                    return res.status
            except urllib.error.HTTPError as err:
                status = err.code
                if status < 500 or attempt >= retries:
                    if status >= 400:
                        log.warning("POST %s -> %d", path, status)
                    return status
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                if attempt >= retries:
                    log.warning("POST %s failed: %s", path, err)
                    return 0
            attempt += 1
            time.sleep(0.5 * attempt)

    def caption(self, room: str, identity: str, text: str, started_at_ms: int) -> int:
        return self.post("/api/internal/captions", caption_payload(room, identity, text, started_at_ms), retries=1)

    def status(self, room: str, state: str) -> int:
        return self.post("/api/internal/captions/status", status_payload(room, state))

    def transcript(self, room: str, model: str, lines: Sequence[TranscriptLine]) -> int:
        return self.post("/api/internal/transcripts", transcript_payload(room, model, lines), retries=3)
