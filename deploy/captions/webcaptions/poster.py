"""What the agent sends the API, and how.

Three endpoints, all authenticated by the shared secret in X-Captions-Secret (the API
compares it in constant time; see api/internal/api/server_captions.go):

    POST /api/internal/captions          one line: a final (stored for the AI, and fanned
                                         out unless the agent already published it to the
                                         room) or a partial (edge viewers only, never stored)
    POST /api/internal/captions/status   live | paused | stopped
    POST /api/internal/transcripts       the after-session transcript

Plain http.client, called from worker threads: a few small JSON posts do not justify another
HTTP dependency, and the agent never blocks its event loop on them. The connection is kept
alive per thread, so a line every few seconds does not pay a TCP + TLS handshake each time.

caption_packet is the room data packet itself (topic "webcast", kind "caption"), which the
agent publishes straight to the SFU it sits next to; web/lib/realtime.ts decodes it.
"""

from __future__ import annotations

import http.client
import json
import logging
import threading
import time
import urllib.parse

# Our own User-Agent, not urllib's. Cloudflare in front of webinarliv.com answers urllib's
# default ("Python-urllib/3.x") with a 403 before the request reaches the API, so on the first
# live test every line and status post was refused while curl from the same box got through.
USER_AGENT = "webinarliv-captions/1.0 (+https://webinarliv.com)"
from dataclasses import dataclass
from typing import Any, Sequence

log = logging.getLogger("captions.poster")

MAX_CAPTION_CHARS = 280  # the API's (and the browser's) cap


def _clean(text: str) -> str:
    return " ".join((text or "").split())[:MAX_CAPTION_CHARS]


def caption_id(identity: str, started_at_ms: int) -> str:
    """One utterance's id: its partials and its final share it, so the final replaces them."""
    return f"{identity}:{int(started_at_ms)}"


def caption_payload(
    room: str,
    identity: str,
    text: str,
    started_at_ms: int,
    *,
    ended_at_ms: int | None = None,
    partial: bool = False,
    published: bool = False,
) -> dict[str, Any]:
    """The body of POST /api/internal/captions.

    `published`: the agent already put this line on the room itself, so the API stores it
    (finals) and copies it to the edge audience, but does not send it to the SFU again.
    `partial`: display-only interim text; the API never stores it."""
    p: dict[str, Any] = {
        "room": room,
        "identity": identity,
        "text": _clean(text),
        "startedAt": int(started_at_ms),
    }
    if ended_at_ms is not None:
        p["endedAt"] = int(ended_at_ms)
        p["id"] = caption_id(identity, started_at_ms)
    if partial:
        p["partial"] = True
    if published:
        p["published"] = True
    return p


def caption_packet(
    sender: dict[str, str],
    text: str,
    started_at_ms: int,
    ended_at_ms: int,
    now_ms: int,
    partial: bool = False,
) -> dict[str, Any]:
    """The "caption" room packet, as the API's relay sends it (handleInternalCaption).

    `lagMs` is how old the end of the captioned audio is as the packet leaves: the edge
    audience, whose video is seconds behind, holds the line until the video gets there."""
    p: dict[str, Any] = {
        "kind": "caption",
        "from": sender,
        "text": _clean(text),
        "id": caption_id(sender["identity"], started_at_ms),
        "startedAt": int(started_at_ms),
        "endedAt": int(ended_at_ms),
        "lagMs": max(0, int(now_ms - ended_at_ms)),
    }
    if partial:
        p["partial"] = True
    return p


def captions_shown(room_metadata: str | None) -> bool | None:
    """The room's captions switch (types.RoomMeta controls.captionsEnabled), from the room
    metadata the API pushes on every change. None when it cannot be read: the agent then
    publishes nothing itself and leaves the decision to the API, which relays as before.
    False is the AI-transcript-only mode: lines are stored, shown to nobody."""
    try:
        meta = json.loads(room_metadata) if room_metadata else None
    except ValueError:
        return None
    controls = meta.get("controls") if isinstance(meta, dict) else None
    if not isinstance(controls, dict) or not isinstance(controls.get("captionsEnabled"), bool):
        return None
    if meta.get("status") not in (None, "live"):
        return False
    return controls["captionsEnabled"]


def sender_for(identity: str, name: str, metadata: str | None) -> dict[str, str]:
    """The packet's `from`: identity, name and role as the API would label it
    (captionSpeaker). The role is in the participant metadata the API minted
    (api/internal/lk metadataFor); a speaker with none reads as a panelist."""
    role = "panelist"
    try:
        meta = json.loads(metadata) if metadata else {}
        if isinstance(meta, dict) and isinstance(meta.get("role"), str) and meta["role"]:
            role = meta["role"]
    except ValueError:
        pass
    return {"identity": identity, "name": (name or "").strip() or "Speaker", "role": role}


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
        u = urllib.parse.urlsplit(self._base)
        self._https = u.scheme == "https"
        self._host = u.hostname or "localhost"
        self._port = u.port
        self._prefix = u.path.rstrip("/")
        self._secret = secret
        self._timeout = timeout
        # One kept-alive connection per thread (http.client connections are not
        # thread-safe; the poster, the status reports and the finalizer each have theirs).
        self._local = threading.local()

    def _conn(self) -> http.client.HTTPConnection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            cls = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
            conn = cls(self._host, self._port, timeout=self._timeout)
            self._local.conn = conn
        return conn

    def _drop(self) -> None:
        conn = getattr(self._local, "conn", None)
        self._local.conn = None
        if conn is not None:
            conn.close()

    def _once(self, path: str, body: bytes) -> tuple[int, bytes]:
        """One request on the kept-alive connection. A connection the server closed while
        idle fails on reuse; that is retried once on a fresh one, not counted as a failure."""
        headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "X-Captions-Secret": self._secret,
        }
        for fresh in (False, True):
            reused = getattr(self._local, "conn", None) is not None and not fresh
            conn = self._conn()
            try:
                conn.request("POST", self._prefix + path, body=body, headers=headers)
                res = conn.getresponse()
                data = res.read()
                if res.will_close:
                    self._drop()
                return res.status, data
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, http.client.BadStatusLine):
                self._drop()
                if not reused:
                    raise
            except BaseException:
                self._drop()
                raise
        raise ConnectionError("unreachable")  # not reached

    def post_json(self, path: str, payload: dict[str, Any], retries: int = 2) -> tuple[int, dict[str, Any]]:
        """Returns the HTTP status (0 when the API could not be reached) and the JSON body
        ({} when there is none). Retries 5xx and network errors with a short backoff; a 4xx
        is the API's answer and is returned."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        attempt = 0
        while True:
            try:
                status, data = self._once(path, body)
                if status < 500 or attempt >= retries:
                    if status >= 400:
                        log.warning("POST %s -> %d", path, status)
                    try:
                        parsed = json.loads(data) if data else {}
                    except ValueError:
                        parsed = {}
                    return status, parsed if isinstance(parsed, dict) else {}
            except (OSError, http.client.HTTPException) as err:
                if attempt >= retries:
                    log.warning("POST %s failed: %s", path, err)
                    return 0, {}
            attempt += 1
            time.sleep(0.5 * attempt)

    def post(self, path: str, payload: dict[str, Any], retries: int = 2) -> int:
        return self.post_json(path, payload, retries)[0]

    def caption(self, room: str, identity: str, text: str, started_at_ms: int) -> int:
        return self.post("/api/internal/captions", caption_payload(room, identity, text, started_at_ms), retries=1)

    def caption_line(
        self,
        room: str,
        identity: str,
        text: str,
        started_at_ms: int,
        ended_at_ms: int,
        partial: bool = False,
        published: bool = False,
    ) -> tuple[int, dict[str, Any]]:
        """A final or a partial with its timing; the answer says whether the room is edge."""
        payload = caption_payload(
            room, identity, text, started_at_ms, ended_at_ms=ended_at_ms, partial=partial, published=published
        )
        # A partial is worth nothing a second later: no retry.
        return self.post_json("/api/internal/captions", payload, retries=0 if partial else 1)

    def status(self, room: str, state: str) -> int:
        return self.status_json(room, state)[0]

    def status_json(self, room: str, state: str) -> tuple[int, dict[str, Any]]:
        return self.post_json("/api/internal/captions/status", status_payload(room, state))

    def transcript_wanted(self, room: str) -> str:
        """Before an after-session pass: "wanted", "skip" (a load test), "gone" (the webinar
        no longer exists) or "unknown" (the API was unreachable, errored, or is too old to
        have POST /api/internal/transcripts/wanted). Only "skip" and "gone" may drop the
        room's audio, and "gone" needs the API's own {"gone": true}: a plain 404 from an API
        without the route must not read as gone."""
        status, body = self.post_json("/api/internal/transcripts/wanted", {"room": room}, retries=1)
        if status == 200 and body.get("wanted") is True:
            return "wanted"
        if status == 200 and body.get("wanted") is False and body.get("reason") == "load_test":
            return "skip"
        if status == 404 and body.get("gone") is True:
            return "gone"
        return "unknown"

    def transcript(self, room: str, model: str, lines: Sequence[TranscriptLine]) -> int:
        return self.post("/api/internal/transcripts", transcript_payload(room, model, lines), retries=3)
