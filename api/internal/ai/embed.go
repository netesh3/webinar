package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

/* Embeddings, for the AI knowledge's vector search.
 *
 * One model only, text-embedding-3-small at 1536 dimensions, on OpenAI's /embeddings
 * endpoint: vectors are only comparable with vectors from the same model, so there is no
 * chain to fall down. When it cannot answer the caller searches without vectors (full-text
 * only), which is what the knowledge did before embeddings existed; nothing a visitor waits
 * on fails because of it.
 *
 * Inputs are sent in batches of EmbedBatch, each clipped to EmbedMaxRunes, so a 50,000-word
 * document is a handful of requests rather than one too large to accept. A failure benches
 * the endpoint briefly (a minute; fifteen for a refused key), so a live Q&A panel does not
 * spend every draft's first seconds rediscovering an outage. */

const (
	EmbedModel = "text-embedding-3-small"
	EmbedDims  = 1536
	// EmbedBatch is the most inputs one request carries (OpenAI accepts 2,048; a smaller batch
	// keeps one request well under its 300k-token limit with ~500-token chunks).
	EmbedBatch = 128
	// EmbedMaxRunes clips one input: about 6k tokens, inside the model's 8,191.
	EmbedMaxRunes = 24_000
)

// ErrBenched is an embedder resting after a failure: nothing was sent, nothing is owed.
var ErrBenched = fmt.Errorf("%w: embeddings benched after a failure", ErrUnavailable)

// Embedding is the vectors for a list of inputs, in their order, and what they cost.
type Embedding struct {
	Vectors      [][]float32
	Provider     string
	Model        string
	PromptTokens int
}

// Embedder turns texts into vectors. Implementations are safe for concurrent use.
type Embedder interface {
	Enabled() bool
	Embed(ctx context.Context, inputs []string) (Embedding, error)
}

// NoEmbedder answers nothing: retrieval is full-text only.
type NoEmbedder struct{}

func (NoEmbedder) Enabled() bool { return false }
func (NoEmbedder) Embed(context.Context, []string) (Embedding, error) {
	return Embedding{}, ErrUnavailable
}

// OpenAIEmbedder is the /embeddings endpoint of an OpenAI-compatible provider.
type OpenAIEmbedder struct {
	ID      string
	BaseURL string
	APIKey  string
	client  *http.Client
	now     func() time.Time

	mu      sync.Mutex
	benched time.Time
}

// NewOpenAIEmbedder is an embedder on baseURL (".../v1") with key.
func NewOpenAIEmbedder(id, baseURL, key string) *OpenAIEmbedder {
	return &OpenAIEmbedder{ID: id, BaseURL: strings.TrimRight(baseURL, "/"), APIKey: key,
		client: &http.Client{Timeout: 20 * time.Second}, now: time.Now}
}

func (e *OpenAIEmbedder) Enabled() bool { return e != nil && e.BaseURL != "" }

func (e *OpenAIEmbedder) bench(d time.Duration) {
	e.mu.Lock()
	e.benched = e.now().Add(d)
	e.mu.Unlock()
}

func (e *OpenAIEmbedder) isBenched() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now().Before(e.benched)
}

type embedRequest struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions"`
}

type embedResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Model string `json:"model"`
	Usage struct {
		PromptTokens int `json:"prompt_tokens"`
	} `json:"usage"`
}

// Embed is every input's vector, batched; ErrUnavailable when the endpoint cannot answer.
func (e *OpenAIEmbedder) Embed(ctx context.Context, inputs []string) (Embedding, error) {
	out := Embedding{Provider: e.ID, Model: EmbedModel}
	if !e.Enabled() {
		return out, ErrUnavailable
	}
	if e.isBenched() {
		return out, ErrBenched
	}
	for start := 0; start < len(inputs); start += EmbedBatch {
		batch := inputs[start:min(start+EmbedBatch, len(inputs))]
		vecs, tokens, err := e.embedBatch(ctx, batch)
		out.PromptTokens += tokens
		if err != nil {
			return out, err
		}
		out.Vectors = append(out.Vectors, vecs...)
	}
	return out, nil
}

// ClipEmbedInput is an input as it is sent: one line of at most EmbedMaxRunes.
func ClipEmbedInput(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > EmbedMaxRunes {
		s = string([]rune(s)[:EmbedMaxRunes])
	}
	if s == "" {
		// The endpoint refuses an empty string.
		s = "."
	}
	return s
}

func (e *OpenAIEmbedder) embedBatch(ctx context.Context, batch []string) ([][]float32, int, error) {
	in := make([]string, len(batch))
	for i, s := range batch {
		in[i] = ClipEmbedInput(s)
	}
	body, err := json.Marshal(embedRequest{Model: EmbedModel, Input: in, Dimensions: EmbedDims})
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.BaseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if e.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+e.APIKey)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			e.bench(30 * time.Second)
		}
		return nil, 0, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, 0, fmt.Errorf("%w: read: %v", ErrUnavailable, err)
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound:
		e.bench(15 * time.Minute)
		return nil, 0, fmt.Errorf("%w: HTTP %d", ErrUnavailable, resp.StatusCode)
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		d := parseRetryAfter(resp.Header.Get("Retry-After"))
		if d <= 0 {
			d = time.Minute
		}
		e.bench(d)
		return nil, 0, fmt.Errorf("%w: HTTP %d", ErrUnavailable, resp.StatusCode)
	case resp.StatusCode != http.StatusOK:
		return nil, 0, fmt.Errorf("%w: HTTP %s", ErrUnavailable, strconv.Itoa(resp.StatusCode))
	}
	var parsed embedResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, 0, fmt.Errorf("%w: unparseable reply", ErrUnavailable)
	}
	vecs, err := orderVectors(parsed, len(batch))
	return vecs, parsed.Usage.PromptTokens, err
}

// orderVectors puts the reply's vectors in input order, refusing one that is not whole.
func orderVectors(r embedResponse, n int) ([][]float32, error) {
	out := make([][]float32, n)
	for _, d := range r.Data {
		if d.Index < 0 || d.Index >= n || len(d.Embedding) != EmbedDims {
			return nil, errors.New("ai: embedding reply has the wrong shape")
		}
		out[d.Index] = d.Embedding
	}
	for _, v := range out {
		if v == nil {
			return nil, errors.New("ai: embedding reply is missing an input")
		}
	}
	return out, nil
}
