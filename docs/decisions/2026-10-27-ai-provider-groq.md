# AI features answer on Groq, OpenAI is the fallback and does the embeddings

**Date:** 2026-10-27. **Revisit when:** Groq's free or paid limits start tripping the
fallback often (the API logs "ai: answered by a fallback provider"), a Groq model's quality
is not good enough for recaps, or Groq offers embeddings.

## Decision

- `AI_PROVIDER=groq|openai` decides which is tried first. Unset, it is **groq when
  `GROQ_API_KEY` is set**, else openai. Production has both keys, so it answers on Groq.
- **Per kind of task** (`AI_GROQ_MODEL_QUALITY`, `AI_GROQ_MODEL_FAST`):
  - quality, `openai/gpt-oss-120b`: recap, follow-ups, repurposed posts, highlights,
    reels, clip post text, lead notes, webinar setup, Q&A clusters (written for a host to
    keep, run once per session)
  - fast, `openai/gpt-oss-20b`: sales chat, chat spam, live Q&A answers and drafts, Q&A
    harvest (short, frequent, inside a live session or a page load)
- **OpenAI stays** as the automatic fallback: the chain benches Groq on a 429 or 5xx and
  asks OpenAI (`gpt-5-nano`, and `gpt-5-mini` for the clip features), with a log line
  each time.
- **Embeddings stay on OpenAI** (`text-embedding-3-small`, 1536 dimensions). Groq offers no
  embeddings, and changing the model would mean re-embedding every knowledge chunk.
  **`OPENAI_API_KEY` remains required** for the AI knowledge.

## How it is asked

gpt-oss on Groq gets its own request body (`groq-reasoning` in `internal/ai`): the chat body
plus `reasoning_effort` (low by default; Groq takes low, medium or high, not "minimal"),
`include_reasoning: false`, and `max_completion_tokens` = the feature's cap + 1,024 for the
reasoning, so a 250-token answer is not all reasoning. Structured answers use
`response_format` json_schema with `strict: true`, which Groq supports for gpt-oss-20b and
gpt-oss-120b. If Groq refuses a schema (400 naming it), the same model is asked again in
words with `json_object`, and the reply is validated as for every provider.

## Cost (list prices, per million tokens in / out)

| Model | In | Out |
|---|---|---|
| Groq `openai/gpt-oss-20b` | $0.075 | $0.30 |
| Groq `openai/gpt-oss-120b` | $0.15 | $0.60 |
| OpenAI `gpt-5-nano` (was the default) | $0.05 | $0.40 |
| OpenAI `gpt-5-mini` (was the clip features) | $0.25 | $2.00 |

A recap (~8,000 tokens in, ~1,500 out plus ~500 reasoning) costs about **$0.0024 on
gpt-oss-120b**, against ~$0.0012 on gpt-5-nano and ~$0.006 on gpt-5-mini. A live Q&A answer
(~1,500 in, ~300 out plus reasoning) is about **$0.0003 on gpt-oss-20b**. Roughly the same
order as before, far below the monthly caps, with a better model for recaps and Groq's much
faster responses. The estimator now prices Groq (it was counted as free).

## Not decided here

The AI is a drafting tool for the host, never the coach: prompts and the privacy page keep
saying so.

## Expected tokens per feature and where it runs

Added 2026-10-27 with token-aware routing (`api/internal/ai/budget.go`). Groq's free tier
allows each model **8,000 tokens a minute** (and 200,000 a day, 30 requests a minute). Groq
counts the reply cap (`max_completion_tokens`) against that budget when a request arrives,
so a request's size is **input + reply cap + 1,024 reasoning headroom**. A request estimated
over `AI_GROQ_MAX_REQUEST_TOKENS` (default **7,000**) goes straight to OpenAI, without
benching Groq; everything smaller stays on Groq. On Groq's Developer tier, raise the budget
(for example to 30,000) and the large features move to Groq too.

Estimates for a typical **one-hour webinar**: ~9,000 spoken words ≈ 54k characters ≈ 13.5k
tokens of transcript, ~16k with the speaker names and timestamps each line carries
(~4 characters per token).

| Feature | What it reads | Input ≈ | Reply cap | Total ≈ (Groq) | Runs on |
|---|---|---|---|---|---|
| Recap | whole transcript (cut into notes only past 200k chars), Q&A, chat | ~17k | 5,000 | ~23k | **OpenAI** |
| Highlights | whole transcript (chunks past 100k chars) | ~16k | 2,500 | ~19.5k | **OpenAI** |
| Reels | whole transcript plus peaks, like highlights | ~16k | 2,500 | ~19.5k | **OpenAI** |
| Repurpose (each format) | whole transcript (direct up to 100k chars) | ~16k | 1,500–5,000 | ~18–22k | **OpenAI** |
| Follow-up drafts | topic, recap summary and key points, groups | ~1.5–2.5k | 4,000 | ~6.5–7.5k | borderline: OpenAI when the recap is long |
| AI knowledge harvest | up to 25 open questions plus knowledge excerpts | ~2–3k | 250 × questions + 400 (6,650 at 25) | ~4–11k | Groq for small batches, OpenAI for full ones |
| Lead notes | per lead: short question and chat lines | ~0.5–2k | 2,500 | ~4–5.5k | Groq |
| Clip post text | one clip's excerpt | ~1–2k | 2,500 | ~4.5–5.5k | Groq |
| Q&A answer (live) | last 5 minutes of captions plus the question | ~1.2–1.5k | 2,500 | ~4.7–5k | Groq |
| Q&A drafts | the questions plus past answers | ~1–2k | 300 × questions + 400 | ~2.5–5k | Groq |
| Auto Q&A | the questions | ~0.5–1.5k | 250 × questions + 400 | ~2–4k | Groq |
| Q&A clusters | the question list | ~1k | 600 | ~2.6k | Groq |
| Chat spam pass | up to 40 pending messages plus 12 sample lines (every 30 s or 20 pending) | ~1.5–2.5k | 1,500 | ~4–5k | Groq |
| Sales chat | the visitor's conversation | ~1–2k | 350 | ~2.4–3.4k | Groq |
| Webinar setup | the host's short brief | ~0.5k | 2,000 | ~3.5k | Groq |

So on the free tier the **transcript-wide features** (recap, highlights, reels, repurpose, and
usually follow-ups and full harvests) go to **OpenAI** (gpt-5-nano / gpt-5-mini as before),
and the **live, frequent ones** (Q&A, spam, sales chat, drafts) stay on **Groq**. The router
logs each skip once: `ai: request over the groq budget, sent to openai` with the feature and
the estimate.
