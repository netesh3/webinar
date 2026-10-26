package ai

/* Token-aware routing (2026-10-27).
 *
 * Groq's free tier allows each model 8,000 tokens a minute (and 200,000 a day). A request
 * bigger than that cannot be served there at all: a one-hour webinar's transcript is ~12k
 * tokens before the recap's instructions and reply, so Groq would answer 413/429 and the
 * chain would fall through to OpenAI anyway — after a wasted round trip, and with Groq
 * benched for every other feature. So the chain estimates a request's size first, and a
 * request over the Groq budget (config AI_GROQ_MAX_REQUEST_TOKENS, default 7000, a margin
 * under 8,000) skips Groq and goes straight to the next provider that is OpenAI. Skipping
 * is not a failure: Groq is not benched, and the small requests keep going to it.
 *
 * The estimate is deliberately cheap: ~4 characters per token for English prose (gpt-oss
 * uses o200k-style tokens, about 4.2 chars per token on English; Hindi/Devanagari runs
 * denser, so 4 errs high, which is the safe side), a few tokens of overhead per message,
 * plus the reply cap and, for Groq's reasoning models, the reasoning headroom. Groq counts
 * max_completion_tokens against the per-minute budget when the request arrives, so the
 * reply cap belongs in the estimate, not only what is actually written. */

// charsPerToken is the estimate's divisor; see above.
const charsPerToken = 4

// perMessageTokens is the chat format's overhead per message (role and separators).
const perMessageTokens = 4

// EstimateTokens is what req is expected to count against provider p's per-minute budget:
// input (messages and any JSON schema sent with them), the reply cap, and p's reasoning
// headroom.
func EstimateTokens(req Request, p Provider) int {
	chars := 0
	for _, m := range req.Messages {
		chars += len([]rune(m.Content))
	}
	if req.Schema != nil {
		chars += len(req.Schema.JSON)
	}
	n := (chars+charsPerToken-1)/charsPerToken + perMessageTokens*len(req.Messages)
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 300
	}
	n += maxTokens
	if p.groqReasoning() {
		n += groqReasoningHeadroom
	}
	return n
}

// SetGroqRequestBudget sets the largest estimated request (tokens) Groq is asked; above
// it the chain skips to an OpenAI provider when there is one. Zero or less means no limit.
func (c *Chain) SetGroqRequestBudget(tokens int) {
	if c == nil {
		return
	}
	c.groqBudget = tokens
}

/* overGroqBudget reports whether provider i should be skipped for req: it is Groq, the
 * request's estimate is over the budget, and a later provider is OpenAI and not benched.
 * Without an OpenAI to go to, Groq is asked anyway and the normal error path decides. */
func (c *Chain) overGroqBudget(i int, req Request) (bool, int) {
	p := c.providers[i]
	if c.groqBudget <= 0 || !p.isGroq() {
		return false, 0
	}
	est := EstimateTokens(req, p)
	if est <= c.groqBudget {
		return false, est
	}
	for _, q := range c.providers[i+1:] {
		if q.isOpenAI() {
			if _, benched := c.isBenched(q.ID); !benched {
				return true, est
			}
		}
	}
	return false, est
}
