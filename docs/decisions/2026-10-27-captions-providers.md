# Captions: Deepgram live from the video box; its finals are the transcript; Groq rejected (2026-10-27)

**Status:** built. On wherever `DEEPGRAM_API_KEY` (and `CAPTIONS_SECRET`) is set:
`CAPTIONS_PROVIDER` defaults to `deepgram` then, else `local`. The separate captions box is
**retired from production on 2026-10-27** and kept only as the local fallback.

## Decision

1. **Live captions come from Deepgram's streaming API** (Nova-3, `language=multi`), fed by a
   light worker that runs **on each video box** as the `captions-worker` compose service
   (`deploy/livekit-box/docker-compose.captions-worker.yml`,
   `deploy/captions/webcaptions/stage_agent.py`). It joins the box's own LiveKit when the API
   dispatches it. Each pool slot (#745) is its own box, so it has its own worker.
2. **Only the stage is heard.** That means the host, co-hosts, panelists and promoted
   attendees (participant role `host` or `panelist`; `stage.is_stage`), and only their
   published, unmuted microphones. Attendees are never subscribed. Lines keep the speaker's
   name.
3. **Voice-activity gating.** Each speaker's audio goes through Silero VAD (the ~2 MB model in
   livekit-plugins-silero, onnxruntime, one thread). `provider.SpeechGate` then:
   - opens a Deepgram socket when speech starts, sending the 400 ms before it first (the
     pre-roll, `CAPTIONS_VAD_PREROLL_MS`);
   - sends while the speaker talks, and sends `Finalize` after 0.5 s of silence;
   - keeps the socket for a 9 s hangover (`CAPTIONS_VAD_HANGOVER_S`), then closes it;
   - closes at once on mute, unpublish or leave.

   Only the pre-roll and speech are ever sent. Every room logs a `captions.cost` line once a
   minute: audio seconds sent, seconds connected, opens, closes and failures.
4. **The live finals ARE the session transcript.** With deepgram there is no spool, no audio
   on disk and no after-session pass. The worker posts the room's finals to
   `POST /api/internal/transcripts` (model `deepgram/nova-3`) when the room ends. That is the
   transcript the recap, the Q&A follow-ups, the knowledge answers and the recording captions
   read. Posting it after the session's end is exactly what the recap waits for
   (`TranscriptAfterEnd`, `FinalizingSessions`), so the recap is written at once. An empty
   room still posts, so the recap never waits out its 30 minutes. A load test
   (`"final":"skip"`) posts nothing.
5. **Groq is rejected** for the after-session transcript (it was considered the same day). The
   finals are already the transcript. A second pass would send the audio to a second third
   party, and it would also mean keeping that audio on disk until the pass ran.
6. **The local path is unchanged** (`CAPTIONS_PROVIDER=local`): the captions box with base.en
   live and large-v3-turbo for the after-session transcript. The large model is used only
   there. The API makes that droplet only with `CAPTIONS_PROVIDER=local` set explicitly **and**
   `CAPTIONS_BOX_ENABLED=true` (`config.CaptionsBoxOn`). The production deploy passes
   `CAPTIONS_BOX_ENABLED` only from the `CAPTIONS_BOX_ENABLED_OVERRIDE` repo variable. Its
   snapshot is built only with repo variable `BUILD_CAPTIONS_IMAGE=true`.

## Why

- **Delay.** In the 2026-10-26 browser load tests (`docs/LOAD-TESTING.md`), live captions on
  `base.en` on the 2-vCPU captions box had a caption delay p90 of **7.8–9.5 s**, against a 4 s
  target. Deepgram sends interim words within a few hundred ms of speech.
- **CPU and a second droplet.**
  - One room of continuous speech held the 2-vCPU captions box at **60–83 %**, and the
    after-session large-v3-turbo pass held it at 91–92 % for ~20 minutes. That box cost
    ~$0.071/h every hour the video box was up.
  - The Deepgram worker is a VAD and a websocket per speaker. Silero measured **0.0022 core
    per speaker** on 120 s of audio on an Apple M-series core. Allow ~5× for a DigitalOcean
    vCPU and the opus decode, about **0.01–0.02 core per speaker**: well under the 0.1-core
    target for a webinar. The compose service is capped at 0.5 CPU and 768 MB at low
    `cpu_shares`.
  - Jobs run as threads of one process, so a room costs megabytes, not a process. The worker
    is ~200 MB RSS in total (measured with the model loaded).
- **Image.**
  - `Dockerfile.light` is python:3.12-slim with livekit-agents, onnxruntime and numpy, about
    **350–450 MB** (estimated; not built here).
  - The Whisper image with CTranslate2 and the seeded model is several GB.
  - The video box snapshot pre-builds the worker image (`build-image.sh`).
- **No fallback model on the video box.** When Deepgram keeps failing (3 failures in a
  minute), the worker reports the room `paused`, so the browsers caption on device as they
  always could, and `live` again once a socket works. This is simpler and more robust than
  shipping Whisper to the video box, which is what the move away from the captions box was
  about.

## Billing

- Deepgram bills **per second of audio streamed** ("true per-second billing",
  deepgram.com/pricing, read 2026-10-27).
- Between utterances only `KeepAlive` text messages are sent, every 5 s; Deepgram closes an
  idle socket after 10 s without audio or KeepAlive. Its docs do not say KeepAlive is billed,
  and it carries no audio. So the bill should be the `captions.cost` audio seconds, not the
  connected seconds. Check the first invoice against those lines.
- **Prices:** Nova-3 streaming is $0.0048/min (English) or $0.0058/min (multilingual). New
  accounts get $200 of credit.
- **Example:** a coach's month of 8 webinar-hours, with one speaker talking ~60 % of the time,
  is ~4.8 h of audio, about **$1.70** with `multi`.

## How the key reaches the box

The API's `boxCaptionsEnv` (`api/internal/api/sfu_box.go`) sends these settings in each
droplet's user data:

- `CAPTIONS_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY`
- `CAPTIONS_SECRET`
- `CAPTIONS_API_URL`
- `CAPTIONS_AGENT_NAME`
- the model and language

They go to a root-only tmpfs file with umask 077, in a quoted heredoc and never logged, the
same as the Grafana token. From there:

1. `sfu-boot.sh` merges them into the volume's `/opt/livekit/.env` (0600) and deletes the file.
2. `redeploy.sh` writes `captions-worker.env` (0600) from `.env` and `.env.keys`, and starts the
   worker only with `CAPTIONS_PROVIDER=deepgram`, a plain-token key and a 32+ character secret.

The deploy workflow (`livekit-do-deploy.yml`) writes the same lines into a box that is already
up. Without captions on the video box, the API sends `CAPTIONS_PROVIDER=off`: the key leaves
`.env` and the worker is removed.

## Privacy

The stage speakers' microphone audio goes to Deepgram while they talk and captions are on. The
audience's audio never does. No audio is kept, only the text. The privacy policy's
service-provider list names Deepgram (`web/app/privacy/page.tsx`, updated 2026-10-27).

## Revisit when

- a load test with Deepgram shows its caption delay (`captions.latency`, the kit's caption
  check): expect p90 under 2 s;
- Hindi or Hinglish matters: test `language=multi` on real sessions;
- Deepgram's prices change, or monthly caption hours pass ~500 (a self-hosted GPU may then be
  cheaper).
