"""Captions provider smoke test (.github/workflows/captions-provider-smoke.yml).

One short live call to Deepgram's streaming API and one Groq transcription of the same clip,
with the repo secrets DEEPGRAM_API_KEY and GROQ_API_KEY, the settings the captions worker uses
(deploy/captions/webcaptions/provider.py, groq_final.py). Prints only status codes, timings and
transcript text: never a key, never the request.

    python3 captions-provider-smoke.py clip.wav
"""

import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave


def read_pcm(path):
    with wave.open(path) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000), "need 16 kHz mono 16-bit WAV"
        return w.readframes(w.getnframes())


async def deepgram(pcm):
    import websockets

    key = os.environ.get("DEEPGRAM_API_KEY", "").strip()
    if not key:
        print("deepgram: DEEPGRAM_API_KEY is not set; skipped")
        return False
    q = urllib.parse.urlencode({
        "model": os.environ.get("CAPTIONS_DEEPGRAM_MODEL") or "nova-3",
        "language": os.environ.get("CAPTIONS_DEEPGRAM_LANGUAGE") or "multi",
        "encoding": "linear16", "sample_rate": 16000, "channels": 1,
        "interim_results": "true", "smart_format": "true", "punctuate": "true", "endpointing": 300,
    })
    t0 = time.monotonic()
    finals, partials = [], 0
    try:
        async with websockets.connect("wss://api.deepgram.com/v1/listen?" + q,
                                      additional_headers={"Authorization": "Token " + key}) as ws:
            print(f"deepgram: connected in {time.monotonic() - t0:.2f}s")

            async def reader():
                nonlocal partials
                async for raw in ws:
                    m = json.loads(raw)
                    if m.get("type") != "Results":
                        continue
                    text = (m["channel"]["alternatives"][0].get("transcript") or "").strip()
                    if not text:
                        continue
                    if m.get("is_final"):
                        finals.append(text)
                        print(f"deepgram final  +{time.monotonic() - t0:5.2f}s: {text}")
                    else:
                        partials += 1

            task = asyncio.create_task(reader())
            step = 3200  # 100 ms, sent in real time as a speaker would
            for i in range(0, len(pcm), step):
                await ws.send(pcm[i:i + step])
                await asyncio.sleep(0.1)
            await ws.send(json.dumps({"type": "CloseStream"}))
            try:
                await asyncio.wait_for(task, 10)
            except asyncio.TimeoutError:
                task.cancel()
    except Exception as err:  # the handshake status is in the message; the key is not
        print(f"deepgram: FAILED: {type(err).__name__}: {err}")
        return False
    print(f"deepgram: {len(finals)} final(s), {partials} interim result(s)")
    return bool(finals)


def groq(path):
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        print("groq: GROQ_API_KEY is not set; skipped")
        return False
    with open(path, "rb") as f:
        data = f.read()
    boundary = "smoke-" + uuid.uuid4().hex
    parts = []
    for k, v in {"model": os.environ.get("CAPTIONS_GROQ_MODEL") or "whisper-large-v3-turbo",
                 "response_format": "verbose_json", "language": "en", "temperature": "0",
                 "timestamp_granularities[]": "segment"}.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
                 f"Content-Type: audio/wav\r\n\r\n".encode() + data + f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/audio/transcriptions", data=b"".join(parts), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": f"multipart/form-data; boundary={boundary}",
                 "User-Agent": "webinarliv-captions-smoke/1.0"},
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status, body = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        print(f"groq: FAILED: HTTP {err.code}")
        return False
    j = json.loads(body)
    print(f"groq: HTTP {status} in {time.monotonic() - t0:.2f}s, {len(j.get('segments') or [])} segment(s)")
    for s in j.get("segments") or []:
        print(f"groq segment {s.get('start', 0):5.2f}-{s.get('end', 0):5.2f}s: {str(s.get('text', '')).strip()}")
    return bool((j.get("text") or "").strip())


def main():
    path = sys.argv[1]
    pcm = read_pcm(path)
    print(f"clip: {len(pcm) / 32000:.1f}s")
    ok_dg = asyncio.run(deepgram(pcm))
    ok_groq = groq(path)
    print(f"result: deepgram {'OK' if ok_dg else 'FAIL'}, groq {'OK' if ok_groq else 'FAIL'}")
    sys.exit(0 if (ok_dg and ok_groq) else 1)


if __name__ == "__main__":
    main()
