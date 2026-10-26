"""Captions provider smoke test (.github/workflows/captions-provider-smoke.yml).

One short live call to Deepgram's streaming API with a few seconds of a test WAV, the repo
secret DEEPGRAM_API_KEY and the settings the video box's caption worker uses
(deploy/captions/webcaptions/provider.py). Prints only the HTTP status, timings and the
transcript: never a key, never the request.

    python3 captions-provider-smoke.py clip.wav
"""

import asyncio
import json
import os
import sys
import time
import urllib.parse
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
            status = getattr(getattr(ws, "response", None), "status_code", 101)
            print(f"deepgram: HTTP {status} (connected in {time.monotonic() - t0:.2f}s)")

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
    except Exception as err:  # the handshake's status, never the key
        status = getattr(getattr(err, "response", None), "status_code", None)
        print(f"deepgram: FAILED: HTTP {status}" if status else f"deepgram: FAILED: {type(err).__name__}")
        return False
    print(f"deepgram: {len(finals)} final(s), {partials} interim result(s)")
    return bool(finals)


def main():
    pcm = read_pcm(sys.argv[1])
    print(f"clip: {len(pcm) / 32000:.1f}s")
    ok = asyncio.run(deepgram(pcm))
    print(f"result: deepgram {'OK' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
