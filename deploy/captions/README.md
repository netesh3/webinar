# Server-side live captions

A LiveKit agent that captions the **active speakers** of a room with multilingual Whisper
(faster-whisper, CTranslate2 int8 on CPU): English, Hindi and code-mixed Hinglish. It runs
on the egress host — the SFU box in local-egress mode, or an egress worker VM — as its own
container, never inside the API. Hindi and Hinglish are shown in **Roman script** by default
("aap kaise hain"), English words untouched.

```
host turns captions on ─▶ API ── agent dispatch ──▶ LiveKit ──▶ caption agent (this)
                                                                   │ subscribes to ≤ N active mics
                                                                   │ energy gate → faster-whisper
          browsers ◀─ room packet "caption" (published by the agent, beside the SFU)
                    ◀─ API relay, only when the agent could not publish
          edge (LL-HLS) viewers ◀─ SSE ◀─ API ◀─ POST /api/internal/captions (async)
                                                 (+ /captions/status, /transcripts)
```

## How it starts and stops

1. The host presses **Captions** in the room. The browser calls
   `POST /api/host/webinars/{slug}/captions/server {on: true}`. The API sets captions on,
   records the request and creates a LiveKit **agent dispatch** (agent name
   `CAPTIONS_AGENT_NAME`, default `webinar-captions`) for the room. Where the API has no
   `CAPTIONS_SECRET` it answers 503 and the browser turns on ordinary on-device captions
   (Whisper tiny.en in each speaker's tab) instead.
2. LiveKit hands the job to a registered caption worker. The agent joins **hidden**, with no
   media publish rights (data packets only), as `CAP_<room>` (filtered from every roster), and posts
   `/api/internal/captions/status {state: "live"}`. Only then does the API set
   `controls.serverCaptions = true` in the room metadata, and the browsers stop their own
   recognition. A dispatch no worker picks up therefore leaves the room on browser captions.
3. Each finished line is **published to the room by the agent itself** as the
   `{kind: "caption", from, text, id, startedAt, endedAt, lagMs}` packet (topic `webcast`)
   while the room metadata says captions are shown, then posted (on a background thread,
   kept-alive connection) to `POST /api/internal/captions {room, identity, text, startedAt,
   endedAt, published: true}`. The API stores it like a browser caption (`session_captions`,
   the transcript download) and copies it to edge viewers over SSE; without `published` (the
   switch is unknown, or the publish failed) it relays to the room as well, as before. With
   captions hidden (AI transcript only) nothing is published; the line is still stored.
   **Interim captions:** while the main source (share audio, else the loudest active speaker)
   is mid-line, the line so far is decoded every `CAPTIONS_PARTIAL_INTERVAL_S` with
   `CAPTIONS_PARTIAL_MODEL` (the fallback model by default) and published with
   `partial: true`; the overlay shows it lighter and replaces it with the final (same `id`).
   NORMAL guard level only, captions shown only, finals always decoded first, never stored
   or spooled. For an edge room (the API says so in its answers) partials are also posted
   with `partial: true` and go only to the edge audience. Edge viewers hold each line by
   their player's delay behind live minus `lagMs`, so it lands with the video.
4. **Off:** the host presses Captions again (`PATCH /controls {captionsEnabled: false}`), or
   `POST …/captions/server {on: false}` (back to browser captions), or the session ends. The
   API deletes the dispatch, LiveKit ends the job, the agent posts `stopped` and leaves.
5. **After the session** the spooled audio of the transcribed speakers (16 kHz mono,
   voiced utterances only, with wall-clock timestamps, on the `captions_spool` volume) is
   re-transcribed with `CAPTIONS_FINAL_MODEL` and posted to `POST /api/internal/transcripts`
   (table `session_transcripts`, segments `{identity, name, start, end, text}` in Unix ms),
   then deleted. This runs on a thread in the agent's main process, only when no room is being
   captioned on that box and the host CPU guard is NORMAL. It will feed the AI recap.

All three internal endpoints check `X-Captions-Secret` against the API's `CAPTIONS_SECRET`
(constant-time) and do not exist when it is unset.

## Video always wins

| Layer | What |
|---|---|
| `cpus` | hard docker cap, `CAPTIONS_CPUS` (default 2 on a 4-vCPU box; half the vCPUs on a worker) |
| `cpu_shares: 256` | a quarter of egress/LiveKit's weight under contention |
| `nice -n 10` | in the image's command |
| `oom_score_adj: 800`, `mem_limit` | the first thing the kernel kills, never the SFU |
| CPU guard | samples **host** `/proc/stat` every 2 s: > 85 % for 10 s → **degraded** (small → base, one speaker, stale windows skipped); > 95 % → **paused** (no decoding; the API is told, browsers caption themselves); back one step after < 70 % for 20 s |
| Active speakers only | at most `CAPTIONS_MAX_SPEAKERS` mic tracks subscribed; silence stops at an RMS gate, so a 50-person room costs what a 5-person one does |
| One decode at a time per room | overlapping speakers queue; a backlog is dropped, not grown |

The guard never touches the egress process. Audio is still written to disk while paused
(cheap) so the final transcript has no holes.

## Environment

Agent (container). On the SFU box put these in `/opt/livekit/.env`; `redeploy.sh` writes
`captions.env` from it plus the LiveKit key.

| Variable | Default | |
|---|---|---|
| `CAPTIONS_ENABLED` | – | `true` to run the agent on the SFU box (redeploy.sh) |
| `CAPTIONS_SECRET` | – | **required**, ≥ 32 chars, same value as the API's |
| `CAPTIONS_API_URL` | `https://webinarliv.com` | where lines are posted |
| `CAPTIONS_AGENT_NAME` | `webinar-captions` | must match the API's |
| `CAPTIONS_MODEL` | `small` | live model (multilingual only: `small`, `base`, `medium`…) |
| `CAPTIONS_FALLBACK_MODEL` | `base` | used while the CPU guard is degraded |
| `CAPTIONS_FINAL_MODEL` | `large-v3-turbo` | after-session pass |
| `CAPTIONS_FINAL_ENABLED` | `true` | `false`: no audio kept, no final transcript |
| `CAPTIONS_LANGUAGE` | `auto` | `auto` (English or Hindi per line, Urdu counted as Hindi), `en`, `hi` |
| `CAPTIONS_SCRIPT` | `roman` | `roman`: Devanagari → Latin Hinglish; `native`: keep Devanagari |
| `CAPTIONS_PROMPT` | – | decoder prompt to bias spellings (product names) |
| `CAPTIONS_MAX_SPEAKERS` | `2` | transcribed at once |
| `CAPTIONS_SPEAKER_LINGER_S` | `3` | a speaker keeps their slot this long after going quiet |
| `CAPTIONS_MAX_ROOMS` | `2` | rooms one worker takes before LiveKit sends jobs elsewhere |
| `CAPTIONS_CPUS` | `2` | docker cap, and decoder threads |
| `CAPTIONS_MEMORY` | `4g` | docker `mem_limit` (SFU box) |
| `CAPTIONS_IMAGE` | – | pull this image instead of building `./captions` on the box |
| `CAPTIONS_ENERGY_GATE` | `0.012` | RMS below which a frame is silence |
| `CAPTIONS_SILENCE_END_S` / `CAPTIONS_MAX_UTTERANCE_S` | `0.45` / `5` | when a line is cut (quiet that ends it / hard cap) |
| `CAPTIONS_SOFT_UTTERANCE_S` / `CAPTIONS_SOFT_SILENCE_S` | `3` / `0.25` | past 3 s a 0.25 s breath ends the line, so a monologue is cut between phrases |
| `CAPTIONS_PARTIALS` | `true` | interim captions for the main speaker (NORMAL only) |
| `CAPTIONS_PARTIAL_INTERVAL_S` | `1` | how often the line so far is decoded (min 0.3) |
| `CAPTIONS_PARTIAL_MODEL` | fallback model | model for interim captions |
| `CAPTIONS_DETECT_MODEL` | fallback model | picks English/Hindi in auto mode (set to the live model for the old behaviour) |
| `CAPTIONS_DIRECT_PUBLISH` | `true` | publish lines to the room directly; `false`: the API relays every line (the old path) |
| `CAPTIONS_CPU_HIGH` / `_CRITICAL` / `_LOW` | `85` / `95` / `70` | guard thresholds, % of host |
| `CAPTIONS_CPU_HIGH_FOR_S` / `_LOW_FOR_S` / `_SAMPLE_S` | `10` / `20` / `2` | guard timing |
| `CAPTIONS_SPOOL_DIR` / `CAPTIONS_SPOOL_MAX_MB` | `/var/lib/captions/spool` / `4096` | audio kept for the final pass |
| `CAPTIONS_MODEL_DIR` | `/models` | weights cache (volume `captions_models`) |
| `CAPTIONS_HEALTH_PORT` | `8091` | the worker's health endpoint (host network) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | – | written by redeploy.sh / startup.sh |

API (Cloud Run): `CAPTIONS_SECRET` (switches the feature on) and optionally
`CAPTIONS_AGENT_NAME`.

Egress worker VMs: instance metadata `captions-image`, `captions-secret` and optionally
`captions-api-url` (see `deploy/egress-worker/startup.sh`). Workers cannot build, so the
image has to be in a registry they can pull from. Note that workers only run while an edge
webinar is live on their project; a standard webinar on a remote-egress SFU box has no
caption worker unless the box itself has `CAPTIONS_ENABLED=true`.

## Sizing (estimates — load-test before relying on them)

| | CPU | Memory |
|---|---|---|
| live `small`, 1–2 active speakers | ≈ 1.5–2 cores while people talk, ~0 in silence | ~0.6 GB per room process (+1 idle prewarmed) |
| live `base` (degraded / 2-vCPU workers) | ≈ 0.5–0.8 cores | ~0.3 GB |
| interim captions (`base` once a second, main speaker, NORMAL only) | ≈ +0.3–0.6 cores while they talk (inside the same docker cap) | none extra (shares the fallback model) |
| final `large-v3-turbo` | slower than real time at 2 cores (≈ 1–2× the session length) | ~1.7 GB while running, freed after |
| disk | 32 KB/s per speaker while they talk (~115 MB/speaking-hour) | deleted after the final pass |

Load test on the real box: a 1080p edge composite + two people talking continuously in
Hinglish, watching `docker stats`, egress frame drops and caption latency; then the same with
the guard thresholds forced low (`CAPTIONS_CPU_HIGH=20`) to see degrade/pause/resume.

First start downloads small (~480 MB), base (~150 MB) and large-v3-turbo (~1.6 GB) into the
`captions_models` volume; later starts are instant.

## Latency

Each room logs once a minute (`captions.latency`):
`caption latency webinar_x: finals 12, partials 30 | e2e p50 … | queue … | decode … | partial … | post … | api_lag … (ms)`.
e2e is end of speech → packet on the SFU; api_lag is end of speech → API answered (the
edge path). The API logs `internal caption: relayed` per line with `age_ms`, `end_age_ms`
and `handler_ms` (Cloud Run logs).

End of a sentence → on screen in the LiveKit room. Decode times measured on an M-series
laptop, int8, 2 threads, TTS English/Hindi clips (re-measure on the box from the log line);
the API handler from Cloud Run request logs; the rest estimated:

| stage | before | after |
|---|---|---|
| quiet that ends the line | 600 ms | 450 ms (250 ms once a line is 3 s long) |
| first word of a monologue | up to 6 s + decode | partial after ~1 s + ~0.5 s (`base`); line cut at a breath ~3–4 s, hard cap 5 s |
| decode, `small` (the encoder always runs on 30 s of padded audio, so 1 s costs ~ 6 s) | ~1.9–2.5 s | same |
| language re-detect (1 line in 4, auto) | +1.7 s (a `small` encoder pass) | +0.45 s (`base`; agreed with `small` on all 6 test clips) |
| POST (new TLS per line) + API handler (p50 32 ms, p90 55 ms) + SFU send | ~150–300 ms | off the display path (async, kept alive) |
| SFU → browser | ~50 ms | ~50 ms |

## Tests

```
cd deploy/captions && pip install -r requirements-dev.txt && python -m pytest -q tests
```

numpy and pytest only: speaker selection, the CPU guard state machine and `/proc/stat`
parsing, Roman transliteration, the segmenter, the post payloads and HTTP client, the live
captioner and the final pass (with a fake transcriber — no model, no LiveKit). The API side
is `api/internal/api/server_captions_test.go`.

## Roman script

`webcaptions/roman.py` is a small rule-based mapper (everyday spellings, Hindi schwa
deletion, short final vowels, nukta sounds), not ITRANS/IAST: those keep every inherent "a"
and use capitals or diacritics, which does not read as Hinglish. It is a heuristic; unusual
words (English loanwords Whisper spelt in Devanagari, mostly) can come out in an odd but
readable spelling. `CAPTIONS_SCRIPT=native` turns it off.
