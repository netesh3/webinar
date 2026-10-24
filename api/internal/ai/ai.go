// Package ai answers a chat prompt with whichever configured model provider can
// take it right now.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* Why a chain, and why every provider speaks the same dialect.
 *
 * The free tiers this is built on all run out: Cloudflare Workers AI gives 10,000
 * Neurons a day and then fails every request until 00:00 UTC, Groq caps tokens per
 * model per day, OpenRouter's free models cap requests per day. One provider is
 * therefore a feature that stops working at some hour of every busy day. Several,
 * tried in order, is a feature that degrades to the next model instead.
 *
 * Every one of them — Cloudflare's /ai/v1 endpoint, Groq, OpenRouter, a local
 * Ollama or vLLM — accepts the OpenAI chat-completions request. So a provider here
 * is only a base URL, a key and a model name, and adding or reordering one is
 * configuration (AI_PROVIDERS), not code.
 *
 * A provider that fails is BENCHED for as long as its failure says it will last,
 * so the chain does not spend every visitor's first second rediscovering that
 * Cloudflare is out of Neurons:
 *
 *   daily quota used up   until the provider's daily reset (00:00 UTC), or its
 *                         Retry-After when it sends one
 *   rate limited (429)    Retry-After, else a minute
 *   unreachable / 5xx     thirty seconds
 *   key or model refused  fifteen minutes — a config error, and loud in the log
 *
 * A 400 is not benched: it is about this request (too long, say), and the next
 * provider may well accept it. When nothing can answer, Complete returns
 * ErrUnavailable and the caller decides what a visitor sees — for the sales chat,
 * that is a person being brought in, which is a better answer than an error.
 */

// ErrUnavailable means no configured provider could answer this request.
var ErrUnavailable = errors.New("ai: no provider is available")

// Message is one turn of a conversation.
type Message struct {
	Role    string `json:"role"` // "system", "user" or "assistant"
	Content string `json:"content"`
}

// Request is what the caller wants answered.
type Request struct {
	Messages []Message
	// MaxTokens caps the reply. Zero means 300, which is a few short paragraphs —
	// enough for a chat answer, and a bound on what one reply can cost.
	MaxTokens int
	// Temperature zero means 0.3: a sales answer should be the same answer twice.
	// Not sent to a reasoning model, which refuses anything but its default.
	Temperature float64
	// ReasoningEffort is for reasoning-style providers only. Empty means "minimal":
	// these features write copy, they do not solve puzzles, and every reasoning token
	// is billed as output.
	ReasoningEffort string
	// Schema, when set, asks for one JSON object matching it. Complete then returns
	// only a reply that parses and validates (see structured.go), trying the next
	// provider when one does not.
	Schema *Schema
	// AttemptTimeout overrides how long one provider gets. Zero means the chain's
	// default (12s), which suits a chat turn; a long structured answer needs more.
	AttemptTimeout time.Duration
	/* Model, when set, is asked of OpenAI's own API (api.openai.com) instead of that
	 * provider's configured model: a per-feature choice (AI_MODEL_HIGHLIGHTS). Every other
	 * provider keeps its own model, since a model name means nothing across providers. When
	 * OpenAI refuses the override (a typo, say) the provider's own model is asked next, and
	 * that refusal never benches the provider: one feature's setting cannot take AI away
	 * from the rest. */
	Model string
}

// Reply is the answer and who gave it.
type Reply struct {
	// Text is the answer; with Request.Schema, compact JSON that validated.
	Text     string
	Provider string
	Model    string
	// PromptTokens and CompletionTokens are the provider's own count (usage), zero
	// when it sent none. The cost estimate is made from them.
	PromptTokens     int
	CompletionTokens int
}

/* Request styles. The chat-completions body is not quite one dialect.
 *
 * Every provider here accepts max_tokens and temperature, except OpenAI's reasoning
 * models (gpt-5*, o-series): they refuse max_tokens in favour of
 * max_completion_tokens, refuse any temperature but the default, and take a
 * reasoning_effort. A provider's Style says which body it gets; the chat style is
 * the original body, byte for byte.
 */
const (
	StyleChat            = "chat"
	StyleOpenAIReasoning = "openai-reasoning"
)

// Provider is one OpenAI-compatible chat endpoint.
type Provider struct {
	ID string
	// BaseURL is everything before /chat/completions, e.g.
	// https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1
	BaseURL string
	APIKey  string
	Model   string
	// Style is StyleChat (or empty) or StyleOpenAIReasoning. See the constants.
	Style string
	// StructuredOutput means the provider honours response_format json_schema. One
	// without it is asked in words, and its reply is parsed tolerantly.
	StructuredOutput bool
}

func (p Provider) reasoning() bool { return p.Style == StyleOpenAIReasoning }

// ProviderStatus is one provider as an operator sees it. Never carries the key.
type ProviderStatus struct {
	ID          string
	Model       string
	Available   bool
	BenchedTill time.Time
	Reason      string
}

type bench struct {
	until  time.Time
	reason string
}

// Chain tries its providers in order. Safe for concurrent use.
type Chain struct {
	providers []Provider
	client    *http.Client
	log       *slog.Logger
	// now is the clock, replaceable so a test can step past a daily reset.
	now func() time.Time
	// attemptTimeout bounds one provider, so a hung one cannot spend the whole
	// request deadline before the next gets a turn.
	attemptTimeout time.Duration

	mu      sync.Mutex
	benched map[string]bench
}

// New builds a chain. An empty list is valid and answers nothing.
func New(providers []Provider, log *slog.Logger) *Chain {
	if log == nil {
		log = slog.Default()
	}
	return &Chain{
		providers:      providers,
		client:         &http.Client{},
		log:            log,
		now:            time.Now,
		attemptTimeout: 12 * time.Second,
		benched:        map[string]bench{},
	}
}

// Enabled reports whether any provider is configured at all.
func (c *Chain) Enabled() bool { return c != nil && len(c.providers) > 0 }

// Complete answers req with the first provider that can.
func (c *Chain) Complete(ctx context.Context, req Request) (Reply, error) {
	if !c.Enabled() {
		return Reply{}, ErrUnavailable
	}
	if req.MaxTokens <= 0 {
		req.MaxTokens = 300
	}
	if req.Temperature == 0 {
		req.Temperature = 0.3
	}

	var tried []string
	for _, p := range c.providers {
		if ctx.Err() != nil {
			break
		}
		if b, ok := c.isBenched(p.ID); ok {
			tried = append(tried, p.ID+": benched ("+b.reason+")")
			continue
		}
		reply, f := c.attemptWith(ctx, p, req)
		if f == nil && req.Schema != nil {
			var err error
			if reply.Text, err = req.Schema.Extract(reply.Text); err != nil {
				f = &failure{invalid: err}
			}
		}
		if f == nil {
			reply.Provider = p.ID
			if reply.Model == "" {
				reply.Model = p.Model
			}
			return reply, nil
		}
		tried = append(tried, p.ID+": "+f.String())
		if d, reason := c.benchFor(f); d > 0 {
			c.setBench(p.ID, d, reason)
			level := slog.LevelWarn
			if f.status == http.StatusUnauthorized || f.status == http.StatusForbidden || f.status == http.StatusNotFound {
				level = slog.LevelError
			}
			c.log.Log(ctx, level, "ai provider benched, trying the next",
				"provider", p.ID, "reason", reason, "for", d.Round(time.Second).String())
		}
	}
	c.log.Warn("ai: no provider answered", "tried", strings.Join(tried, "; "))
	return Reply{}, ErrUnavailable
}

/* attemptWith is one provider's turn: the request's Model override first when it applies to
 * this provider, then (if the override fails) the provider's own model. Reply.Model is set
 * only when the override answered. */
func (c *Chain) attemptWith(ctx context.Context, p Provider, req Request) (Reply, *failure) {
	if op, ok := p.withModel(req.Model); ok {
		reply, f := c.attempt(ctx, op, req)
		if f == nil && req.Schema != nil {
			if _, err := req.Schema.Extract(reply.Text); err != nil {
				f = &failure{invalid: err}
			}
		}
		if f == nil {
			reply.Model = op.Model
			return reply, nil
		}
		c.log.Warn("ai: model override did not answer, asking the provider's own model",
			"provider", p.ID, "model", op.Model, "reason", f.String())
		if ctx.Err() != nil {
			return Reply{}, f
		}
	}
	return c.attempt(ctx, p, req)
}

/* withModel is p asked for model instead of its own: only OpenAI's own API, and only a
 * different model. The body style follows the model, as config decides it for OPENAI_MODEL
 * (a gpt-5 or o-series model takes the reasoning body). */
func (p Provider) withModel(model string) (Provider, bool) {
	model = strings.TrimSpace(model)
	if model == "" || strings.EqualFold(model, p.Model) || !p.isOpenAI() {
		return p, false
	}
	p.Model = model
	p.Style = StyleChat
	if reasoningModel(model) {
		p.Style = StyleOpenAIReasoning
	}
	return p, true
}

func (p Provider) isOpenAI() bool {
	u, err := url.Parse(p.BaseURL)
	return err == nil && strings.EqualFold(u.Hostname(), openAIHost)
}

// openAIHost is OpenAI's API host; a var so a test can point it at its fake.
var openAIHost = "api.openai.com"

// reasoningModel is OpenAI's reasoning families: gpt-5* and the o-series (o1, o3, o4 …).
func reasoningModel(model string) bool {
	m := strings.ToLower(model)
	if strings.HasPrefix(m, "gpt-5") {
		return true
	}
	return len(m) >= 2 && m[0] == 'o' && m[1] >= '1' && m[1] <= '9'
}

// Status is every provider and whether it is taking requests, in priority order.
func (c *Chain) Status() []ProviderStatus {
	out := make([]ProviderStatus, 0, len(c.providers))
	for _, p := range c.providers {
		st := ProviderStatus{ID: p.ID, Model: p.Model, Available: true}
		if b, ok := c.isBenched(p.ID); ok {
			st.Available, st.BenchedTill, st.Reason = false, b.until, b.reason
		}
		out = append(out, st)
	}
	return out
}

func (c *Chain) isBenched(id string) (bench, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.benched[id]
	if !ok {
		return bench{}, false
	}
	if !c.now().Before(b.until) {
		delete(c.benched, id)
		return bench{}, false
	}
	return b, true
}

func (c *Chain) setBench(id string, d time.Duration, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.benched[id] = bench{until: c.now().Add(d), reason: reason}
}

// failure is one provider's refusal, kept whole so benchFor can read it.
type failure struct {
	status     int // 0 when no HTTP response arrived
	retryAfter time.Duration
	body       string
	err        error
	empty      bool  // 200 with nothing in it
	invalid    error // 200, but not JSON matching the requested schema
}

func (f *failure) String() string {
	switch {
	case f.empty:
		return "empty reply"
	case f.invalid != nil:
		return "reply did not match the schema: " + f.invalid.Error()
	case f.status == 0:
		return "unreachable: " + f.err.Error()
	default:
		return "HTTP " + strconv.Itoa(f.status)
	}
}

/* quotaWords recognises "you have used today's allowance" in the providers' own words.
 *
 * Cloudflare answers an exhausted free allocation with error code 4006 ("you have used up
 * your daily free allocation of 10,000 neurons"); Groq names the window ("tokens per day
 * (TPD)"); OpenAI-style providers say insufficient_quota; OpenRouter says the free-model
 * daily limit.
 *
 * Kept narrow, because the two mistakes cost different amounts. Missing a daily limit and
 * calling it per-minute costs one wasted retry a minute later. Calling a per-minute limit
 * daily benches the main provider until midnight. That is why a bare "quota" is not on the
 * list, and why a Retry-After, when the provider sends one, still wins over the guess
 * (see untilDailyReset).
 */
var quotaWords = regexp.MustCompile(`(?i)\b4006\b|daily|per day|\(TPD\)|\(RPD\)|neurons|insufficient_quota`)

func (c *Chain) benchFor(f *failure) (time.Duration, string) {
	switch {
	case f.empty, f.invalid != nil:
		return 0, ""
	case f.status == 0:
		return 30 * time.Second, "unreachable"
	case f.status == http.StatusPaymentRequired:
		return c.untilDailyReset(f.retryAfter), "out of credit"
	case f.status == http.StatusTooManyRequests && quotaWords.MatchString(f.body):
		return c.untilDailyReset(f.retryAfter), "daily quota used up"
	case f.status == http.StatusTooManyRequests:
		if f.retryAfter > 0 {
			return f.retryAfter, "rate limited"
		}
		return time.Minute, "rate limited"
	case f.status == http.StatusUnauthorized || f.status == http.StatusForbidden:
		return 15 * time.Minute, "credentials refused (check the API key)"
	case f.status == http.StatusNotFound:
		return 15 * time.Minute, "model or endpoint not found (check the model name)"
	case f.status >= 500:
		return 30 * time.Second, "provider error " + strconv.Itoa(f.status)
	default:
		return 0, "" // about this request, not the provider
	}
}

// untilDailyReset prefers the provider's own Retry-After; otherwise it waits for
// 00:00 UTC, which is when Cloudflare and OpenRouter both reset.
func (c *Chain) untilDailyReset(retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		return retryAfter
	}
	now := c.now().UTC()
	midnight := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	return midnight.Sub(now)
}

/* chatRequest is the wire body. Field order and the always-present fields are the
 * original chat style exactly (a test pins the bytes); everything a reasoning model or
 * a schema adds is omitempty, so a chat-style provider never sees it. */
type chatRequest struct {
	Model               string          `json:"model"`
	Messages            []Message       `json:"messages"`
	MaxTokens           int             `json:"max_tokens,omitempty"`
	Temperature         *float64        `json:"temperature,omitempty"`
	Stream              bool            `json:"stream"`
	MaxCompletionTokens int             `json:"max_completion_tokens,omitempty"`
	ReasoningEffort     string          `json:"reasoning_effort,omitempty"`
	ResponseFormat      *responseFormat `json:"response_format,omitempty"`
}

type responseFormat struct {
	Type       string          `json:"type"`
	JSONSchema *jsonSchemaSpec `json:"json_schema,omitempty"`
}

type jsonSchemaSpec struct {
	Name   string          `json:"name"`
	Schema json.RawMessage `json:"schema"`
	Strict bool            `json:"strict"`
}

// buildRequest is the body provider p gets for req, which has its defaults applied.
func buildRequest(p Provider, req Request) chatRequest {
	out := chatRequest{Model: p.Model, Messages: req.Messages}
	if p.reasoning() {
		out.MaxCompletionTokens = req.MaxTokens
		out.ReasoningEffort = req.ReasoningEffort
		if out.ReasoningEffort == "" {
			out.ReasoningEffort = "minimal"
		}
	} else {
		t := req.Temperature
		out.MaxTokens, out.Temperature = req.MaxTokens, &t
	}
	if req.Schema != nil {
		if p.StructuredOutput {
			out.ResponseFormat = &responseFormat{Type: "json_schema", JSONSchema: &jsonSchemaSpec{
				Name: req.Schema.Name, Schema: req.Schema.JSON, Strict: true,
			}}
		} else {
			out.Messages = req.Schema.instruct(req.Messages)
		}
	}
	return out
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

// maxResponseBytes bounds what one provider can make this process read.
const maxResponseBytes = 1 << 20

func (c *Chain) attempt(ctx context.Context, p Provider, req Request) (Reply, *failure) {
	timeout := c.attemptTimeout
	if req.AttemptTimeout > 0 {
		timeout = req.AttemptTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body, err := json.Marshal(buildRequest(p, req))
	if err != nil {
		return Reply{}, &failure{err: err}
	}
	url := strings.TrimRight(p.BaseURL, "/") + "/chat/completions"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return Reply{}, &failure{err: err}
	}
	hreq.Header.Set("Content-Type", "application/json")
	if p.APIKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+p.APIKey)
	}

	resp, err := c.client.Do(hreq)
	if err != nil {
		return Reply{}, &failure{err: err}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Reply{}, &failure{err: fmt.Errorf("read: %w", err)}
	}
	if resp.StatusCode != http.StatusOK {
		return Reply{}, &failure{
			status:     resp.StatusCode,
			retryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			body:       string(raw),
		}
	}

	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// A 200 that is not the shape we asked for is the provider's fault.
		return Reply{}, &failure{status: http.StatusBadGateway, body: "unparseable reply"}
	}
	if len(parsed.Choices) == 0 {
		return Reply{}, &failure{empty: true}
	}
	text := cleanReply(parsed.Choices[0].Message.Content)
	if text == "" {
		return Reply{}, &failure{empty: true}
	}
	return Reply{
		Text:             text,
		PromptTokens:     parsed.Usage.PromptTokens,
		CompletionTokens: parsed.Usage.CompletionTokens,
	}, nil
}

// thinkBlock is the reasoning some open models (Qwen3, DeepSeek-R1) emit before the
// answer. It is for the model, not for a visitor.
var thinkBlock = regexp.MustCompile(`(?s)<think>.*?</think>`)

func cleanReply(s string) string {
	s = thinkBlock.ReplaceAllString(s, "")
	// An unclosed block means the reply was cut off mid-thought: nothing usable.
	if i := strings.Index(s, "<think>"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// parseRetryAfter reads seconds or an HTTP date; zero when absent or unreadable.
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Second))
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
