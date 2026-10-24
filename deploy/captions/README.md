# Server-side live captions

A LiveKit agent that captions the **active speakers** of a room in **English only** with
Whisper (faster-whisper, CTranslate2 int8 on CPU). It runs on the egress host — the SFU box
in local-egress mode, or an egress worker VM — as its own container, never inside the API.
There is no language detection and no other language or script: every pass decodes with
`language="en"`.

```
host turns captions on ─▶ API ── agent dispatch ──▶ LiveKit ──▶ caption agent (this)
                                                                   │ subscribes to every mic, transcribes ≤ N active
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
   then deleted. A thread in the agent's main process drives it, but the model runs in a
   child process (`python -m webcaptions.finalizer <dir>`), started only when no room is being
   captioned on that box and the host CPU guard is NORMAL, and **stopped the moment a room
   goes live** (its ~1.2 GB and its CPU come back at once). Every finished 30 s window is
   checkpointed in the room's spool directory (`final.progress`), so the next child carries on
   where the last one stopped. (Until 24 Oct 2026 the model loaded in the main process and
   stayed resident through the next live session: 3.6 GB of the 4 GB container limit during a
   webinar, after 40 minutes at the full 2-core cap.) It feeds the AI recap, which waits
   for it (up to 30 min): a room where nobody spoke still gets an empty transcript posted, so
   the recap is not held. The spool is a volume, so a container replaced mid-pass (a deploy)
   resumes every pending room on start (`Finalizer.resume`); box deploys also wait for
   sessions in this state ("finalizing" in `/api/internal/live-status`).

All three internal endpoints check `X-Captions-Secret` against the API's `CAPTIONS_SECRET`
(constant-time) and do not exist when it is unset.

## Video always wins

| Layer | What |
|---|---|
| `cpus` | hard docker cap, `CAPTIONS_CPUS` (default 2 on a 4-vCPU box; half the vCPUs on a worker) |
| `cpu_shares: 256` | a quarter of egress/LiveKit's weight under contention |
| `nice -n 10` | in the image's command |
| `oom_score_adj: 800`, `mem_limit` | the first thing the kernel kills, never the SFU |
| CPU guard | samples **host** `/proc/stat` every 2 s: > 85 % for 10 s → **degraded** (the fallback model if it differs from the live one, one speaker, stale windows skipped); > 95 % → **paused** (no decoding; the API is told, browsers caption themselves); back one step after < 70 % for 20 s |
| Active speakers only | every mic is subscribed (LiveKit only reports active speakers a participant is subscribed to), but only `CAPTIONS_MAX_SPEAKERS` of them reach the model; silence stops at an RMS gate, so a 50-person room costs what a 5-person one does |
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
| `CAPTIONS_MODEL` | `base.en` | live model (`base.en`, `small.en`, `medium.en`…); `small.en` is ~2–3× the CPU for somewhat better words |
| `CAPTIONS_FALLBACK_MODEL` | `base.en` | used while the CPU guard is degraded |
| `CAPTIONS_FINAL_MODEL` | `large-v3-turbo` | after-session pass, decoded as English (see Models) |
| `CAPTIONS_FINAL_ENABLED` | `true` | `false`: no audio kept, no final transcript |
| `CAPTIONS_LANGUAGE` | `en` | the only value; anything else (old `auto`/`hi`) is logged as a warning and ignored. `CAPTIONS_SCRIPT` likewise |
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
| `CAPTIONS_DIRECT_PUBLISH` | `true` | publish lines to the room directly; `false`: the API relays every line (the old path) |
| `CAPTIONS_CPU_HIGH` / `_CRITICAL` / `_LOW` | `85` / `95` / `70` | guard thresholds, % of host |
| `CAPTIONS_CPU_HIGH_FOR_S` / `_LOW_FOR_S` / `_SAMPLE_S` | `10` / `20` / `2` | guard timing |
| `CAPTIONS_SPOOL_DIR` / `CAPTIONS_SPOOL_MAX_MB` | `/var/lib/captions/spool` / `4096` | audio kept for the final pass |
| `CAPTIONS_MODEL_DIR` | `/models` | weights cache (volume `captions_models`) |
| `CAPTIONS_MODEL_SEED_DIR` | `/opt/models-seed` | weights baked into the image (build arg `CAPTIONS_SEED_MODELS`, default `base.en`), copied into the cache when it lacks them |
| `CAPTIONS_HEALTH_PORT` | `8091` | the worker's health endpoint (host network) |
| `CAPTIONS_METRICS_PORT` | `0` (off) | livekit-agents' Prometheus `/metrics` (`lk_agents_active_job_count` = rooms held, `lk_agents_worker_load`, `lk_agents_child_process_count`); the captions box sets `8092` for Alloy |
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
| live `base.en` (the default), 1–2 active speakers | ≈ 0.5–0.8 cores while people talk, ~0 in silence | ~0.3 GB per room process (+1 idle prewarmed) |
| live `small.en` (`CAPTIONS_MODEL=small.en`) | ≈ 1.5–2 cores (measured 24 Oct 2026 on the shared c-4: 0.66 cores average over a session, which pushed the box to 70–91 % beside the composite) | ~0.6 GB |
| interim captions (`base.en` once a second, main speaker, NORMAL only) | ≈ +0.3–0.6 cores while they talk (inside the same docker cap) | none extra (shares the fallback model) |
| final `large-v3-turbo` | the full cap while it runs: ~12 s of 2 cores per 30 s window, however little speech is in it (measured 24 Oct 2026), so windows join across pauses up to 8 s | ~1.2–1.7 GB in its child process, only between live sessions |
| disk | 32 KB/s per speaker while they talk (~115 MB/speaking-hour) | deleted after the final pass |

Load test on the real box: a 1080p edge composite + two people talking continuously in
English, watching `docker stats`, egress frame drops and caption latency; then the same with
the guard thresholds forced low (`CAPTIONS_CPU_HIGH=20`) to see degrade/pause/resume.

base.en (~150 MB) is baked into the image and copied into the `captions_models` volume when it
is missing; the first start downloads large-v3-turbo (~1.6 GB, the after-session pass) and
`CAPTIONS_MODEL` if it is another model (small.en ~480 MB). Later starts are instant.

## Runbook

Captions run only on the on-demand captions box (`captions-blr-1`, see
`deploy/digitalocean/README.md`); the video box runs no caption agent.

- **A video box still runs its own agent** (booted before that change; memory and CPU in
  Grafana under `service="captions"` on the video box): stop it, on the video box,
  `docker stop livekit-captions-1` (its 40 s grace lets the job post `stopped`; plain
  `docker compose stop captions` needs `-f docker-compose.captions.yml` too). It stays
  stopped until the next redeploy, which no longer starts it. Video is not touched. A room it was captioning loses server captions for a moment: its job
  ends, the room's browsers fall back to on-device captions, and the API's captions-box step
  re-creates the dispatch (`RedispatchIdle`, a dispatch with no running job), which the
  captions box's worker takes. Check with LiveKit's `assigned job to worker` log line (the
  captions box's worker id is in its `worker registered` line). If the room stays on
  on-device captions, the host turns server captions off and on.
- **`not dispatching agent job since no worker is available` with `jobType` `JT_PARTICIPANT`
  or `JT_PUBLISHER`** in LiveKit's log, on every join and publish: harmless. LiveKit asks for
  a participant/publisher agent each time; this worker registers for room jobs (`JT_ROOM`,
  explicit dispatch by agent name) only. What matters is `assigned job to worker` for
  `JT_ROOM`. A room whose dispatch already has a running job stays with that worker: a new
  worker registering takes only new rooms (or ones whose job ended).
- **Worker load** is rooms held over `CAPTIONS_MAX_ROOMS` (`config.room_load`), never the host
  CPU, so a busy host does not make LiveKit think the worker is gone; the CPU guard steps
  down instead.

## Latency

Each room logs once a minute (`captions.latency`):
`caption latency webinar_x: finals 12, partials 30 | e2e p50 … | queue … | decode … | partial … | post … | api_lag … (ms)`.
e2e is end of speech → packet on the SFU; api_lag is end of speech → API answered (the
edge path). The API logs `internal caption: relayed` per line with `age_ms`, `end_age_ms`
and `handler_ms` (Cloud Run logs).

End of a sentence → on screen in the LiveKit room. Decode times measured on an M-series
laptop, int8, 2 threads, TTS English clips (re-measure on the box from the log line);
the API handler from Cloud Run request logs; the rest estimated:

| stage | before | after |
|---|---|---|
| quiet that ends the line | 600 ms | 450 ms (250 ms once a line is 3 s long) |
| first word of a monologue | up to 6 s + decode | partial after ~1 s + ~0.5 s (`base.en`); line cut at a breath ~3–4 s, hard cap 5 s |
| decode, `small.en` (the encoder always runs on 30 s of padded audio, so 1 s costs ~ 6 s) | ~1.9–2.5 s | same |
| language detection | +1.7 s on 1 line in 4 (multilingual `small`) | none (English only) |
| POST (new TLS per line) + API handler (p50 32 ms, p90 55 ms) + SFU send | ~150–300 ms | off the display path (async, kept alive) |
| SFU → browser | ~50 ms | ~50 ms |

## Tests

```
cd deploy/captions && pip install -r requirements-dev.txt && python -m pytest -q tests
```

numpy and pytest only: speaker selection, the CPU guard state machine and `/proc/stat`
parsing, the segmenter, the post payloads and HTTP client, the live
captioner and the final pass (with a fake transcriber — no model, no LiveKit). The API side
is `api/internal/api/server_captions_test.go`.

## Models

Live: `base.en` (default) or `small.en`. On English the English-only checkpoints are more accurate
than the multilingual ones of the same size (OpenAI's own results; the gap is largest at
`base`/`small`), cost the same to decode, and never need a language-detection pass. They
also cannot drift into another language or script, which is what the old multilingual
setup (Hindi/Hinglish, Roman transliteration, Urdu-script filtering) kept doing.

After the session: `large-v3-turbo` with `language="en"`. There is no `.en` large model;
`distil-large-v3` is the English-only alternative, about the same size and somewhat faster,
but it is tuned for its own chunked long-form decoding and is no more accurate on English
than turbo, whose weights are already in the `captions_models` volume of every running box.
Speed does not matter here (the pass runs only while the box is idle), so turbo stays; set
`CAPTIONS_FINAL_MODEL=distil-large-v3` to try it.
