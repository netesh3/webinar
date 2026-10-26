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
