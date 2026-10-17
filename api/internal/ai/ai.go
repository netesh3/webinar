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
	Temperature float64
}

// Reply is the answer and who gave it.
type Reply struct {
	Text     string
	Provider string
	Model    string
}

// Provider is one OpenAI-compatible chat endpoint.
type Provider struct {
	ID string
	// BaseURL is everything before /chat/completions, e.g.
	// https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1
	BaseURL string
	APIKey  string
	Model   string
}

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
		text, f := c.attempt(ctx, p, req)
		if f == nil {
			return Reply{Text: text, Provider: p.ID, Model: p.Model}, nil
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
	empty      bool // 200 with nothing in it
}

func (f *failure) String() string {
	switch {
	case f.empty:
		return "empty reply"
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
	case f.empty:
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

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	MaxTokens   int       `json:"max_tokens"`
	Temperature float64   `json:"temperature"`
	Stream      bool      `json:"stream"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// maxResponseBytes bounds what one provider can make this process read.
const maxResponseBytes = 1 << 20

func (c *Chain) attempt(ctx context.Context, p Provider, req Request) (string, *failure) {
	ctx, cancel := context.WithTimeout(ctx, c.attemptTimeout)
	defer cancel()

	body, err := json.Marshal(chatRequest{
		Model: p.Model, Messages: req.Messages,
		MaxTokens: req.MaxTokens, Temperature: req.Temperature,
	})
	if err != nil {
		return "", &failure{err: err}
	}
	url := strings.TrimRight(p.BaseURL, "/") + "/chat/completions"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", &failure{err: err}
	}
	hreq.Header.Set("Content-Type", "application/json")
	if p.APIKey != "" {
		hreq.Header.Set("Authorization", "Bearer "+p.APIKey)
	}

	resp, err := c.client.Do(hreq)
	if err != nil {
		return "", &failure{err: err}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", &failure{err: fmt.Errorf("read: %w", err)}
	}
	if resp.StatusCode != http.StatusOK {
		return "", &failure{
			status:     resp.StatusCode,
			retryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
			body:       string(raw),
		}
	}

	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// A 200 that is not the shape we asked for is the provider's fault.
		return "", &failure{status: http.StatusBadGateway, body: "unparseable reply"}
	}
	if len(parsed.Choices) == 0 {
		return "", &failure{empty: true}
	}
	text := cleanReply(parsed.Choices[0].Message.Content)
	if text == "" {
		return "", &failure{empty: true}
	}
	return text, nil
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
