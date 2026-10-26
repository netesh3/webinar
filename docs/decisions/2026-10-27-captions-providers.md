# Captions: Deepgram for live, Groq for the after-session transcript (2026-10-27)

**Status:** built behind settings, off by default (`CAPTIONS_PROVIDER=local`,
`CAPTIONS_FINAL_PROVIDER=local`). Turned on per environment once the API keys exist and a load
test with the providers on has run.

## Decision

1. **Live captions can come from Deepgram's streaming API** (Nova-3) instead of the captions
   box's own Whisper model: `CAPTIONS_PROVIDER=deepgram` plus `DEEPGRAM_API_KEY`
   (`deploy/captions/webcaptions/provider.py`). The box's model stays as a fallback
   (`CAPTIONS_FALLBACK_LOCAL=true`) that takes a room over when Deepgram keeps failing.
2. **The after-session transcript can come from Groq** (`whisper-large-v3-turbo`) instead of
   the box running large-v3-turbo itself: `CAPTIONS_FINAL_PROVIDER=groq` plus `GROQ_API_KEY`
   (`deploy/captions/webcaptions/groq_final.py`).
3. The self-hosted path stays as it is and stays the default: nothing changes until the
   settings are flipped, and flipping them back is a deploy.

## Why

- **Delay.** In the 2026-10-26 browser load tests (`docs/LOAD-TESTING.md`), live captions on
  `base.en` on the 2-vCPU captions box had a caption delay p90 of **7.8–9.5 s** against the 4 s
  target. Streaming providers send interim words within a few hundred ms of speech.
- **CPU.** One room of continuous speech held the 2-vCPU box at **60–83 %** (1.2–1.6 cores),
  so the then-configured 4 rooms per box could not have run together (the box is now 4 vCPU
  with 2 rooms, [2026-10-27](2026-10-27-captions-box-size.md)). With Deepgram the box only moves
  audio: without the local fallback it defaults to s-1vcpu-2gb with 8 rooms.
- **The after-session pass.** large-v3-turbo held the whole box (91–92 %) for ~20 minutes
  after a session (18:43–19:03 UTC on 2026-10-26), paused whenever a room went live, and so
  delayed transcripts on busy days. Groq runs the same model family ~200× real time in its
  cloud: the box's CPU is left for live captions.

## Cost

| | Price | A coach's month (8 webinar-hours, ~1 speaker) |
|---|---|---|
| Deepgram Nova-3 streaming, English | $0.0048/min ($0.29/h) | ~$2.30 |
| Deepgram Nova-3 streaming, multilingual (`language=multi`) | $0.0058/min ($0.35/h) | ~$2.80 |
| Groq `whisper-large-v3-turbo` (batch; **10 s minimum billed per request**) | ~$0.04 per audio hour (from memory; check groq.com/pricing) | ~$0.32 |
| Self-hosted (captions box, on demand) | s-4vcpu-8gb ~$0.071/h while up ([#755](2026-10-27-captions-box-size.md): 2 rooms) | shared by every room on the box |

Deepgram gives new accounts $200 of credit (~700 h of Nova-3). Deepgram bills streamed audio:
the worker sends audio only for the selected speakers (`selection.py`) and closes each socket
when its track ends.

## Privacy

Both send the speakers' audio to a third party. The privacy policy's service-provider list
names Deepgram (live captions, while a host has captions on) and Groq (after-session
transcript), "where enabled" (`web/app/privacy/page.tsx`, updated 2026-10-27).

## Revisit when

- the load test with `CAPTIONS_PROVIDER=deepgram` shows its caption delay (the
  `captions.latency` log lines and the kit's caption check) — expect p90 under 2 s;
- Hindi or Hinglish matters: `language=multi` is Nova-3's code-switching mode; test it on real
  sessions before relying on it;
- Deepgram or Groq prices change, or monthly caption hours pass ~500 (a self-hosted GPU may
  then be cheaper).
