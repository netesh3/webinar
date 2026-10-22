package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// wire is a provider that keeps the raw request body and answers a fixed reply.
type wire struct {
	srv    *httptest.Server
	mu     sync.Mutex
	bodies []string
	reply  string
	usage  map[string]int
}

func newWire(t *testing.T, reply string) *wire {
	t.Helper()
	w := &wire{reply: reply}
	w.srv = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		w.mu.Lock()
		w.bodies = append(w.bodies, string(raw))
		w.mu.Unlock()
		out := map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": w.reply}}},
		}
		if w.usage != nil {
			out["usage"] = w.usage
		}
		_ = json.NewEncoder(rw).Encode(out)
	}))
	t.Cleanup(w.srv.Close)
	return w
}

func (w *wire) last() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.bodies) == 0 {
		return ""
	}
	return w.bodies[len(w.bodies)-1]
}

// The chat style is the body the free providers have always had, byte for byte.
func TestChatStyleBodyIsUnchanged(t *testing.T) {
	w := newWire(t, "hello")
	c := New([]Provider{{ID: "groq", BaseURL: w.srv.URL, APIKey: "k", Model: "m"}}, quiet())
	if _, err := c.Complete(context.Background(), hi); err != nil {
		t.Fatal(err)
	}
	want := `{"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":300,"temperature":0.3,"stream":false}`
	if got := w.last(); got != want {
		t.Fatalf("body =\n%s\nwant\n%s", got, want)
	}

	if _, err := c.Complete(context.Background(), Request{Messages: hi.Messages, MaxTokens: 350, Temperature: 0.7}); err != nil {
		t.Fatal(err)
	}
	want = `{"model":"m","messages":[{"role":"user","content":"hi"}],"max_tokens":350,"temperature":0.7,"stream":false}`
	if got := w.last(); got != want {
		t.Fatalf("body =\n%s\nwant\n%s", got, want)
	}
}

func TestReasoningStyleBody(t *testing.T) {
	w := newWire(t, "hello")
	w.usage = map[string]int{"prompt_tokens": 120, "completion_tokens": 40}
	c := New([]Provider{{ID: "openai", BaseURL: w.srv.URL, APIKey: "k", Model: "gpt-5-nano", Style: StyleOpenAIReasoning}}, quiet())
	r, err := c.Complete(context.Background(), Request{Messages: hi.Messages, MaxTokens: 500})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"model":"gpt-5-nano","messages":[{"role":"user","content":"hi"}],"stream":false,"max_completion_tokens":500,"reasoning_effort":"minimal"}`
	if got := w.last(); got != want {
		t.Fatalf("body =\n%s\nwant\n%s", got, want)
	}
	if r.PromptTokens != 120 || r.CompletionTokens != 40 || r.Provider != "openai" || r.Model != "gpt-5-nano" {
		t.Fatalf("reply = %+v", r)
	}

	if _, err := c.Complete(context.Background(), Request{Messages: hi.Messages, ReasoningEffort: "low"}); err != nil {
		t.Fatal(err)
	}
	if got := w.last(); !strings.Contains(got, `"reasoning_effort":"low"`) || strings.Contains(got, "temperature") || strings.Contains(got, `"max_tokens"`) {
		t.Fatalf("override: body = %s", got)
	}
}

var testSchema = NewSchema("greeting", `{
  "type":"object","additionalProperties":false,
  "required":["title","tags"],
  "properties":{
    "title":{"type":"string"},
    "tags":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"string"}}
  }
}`)

func TestStructuredOutputUsesResponseFormatWhenSupported(t *testing.T) {
	w := newWire(t, `{"title":"Hi","tags":["a","b"]}`)
	c := New([]Provider{{ID: "openai", BaseURL: w.srv.URL, APIKey: "k", Model: "gpt-5-nano",
		Style: StyleOpenAIReasoning, StructuredOutput: true}}, quiet())
	r, err := c.Complete(context.Background(), Request{Messages: hi.Messages, Schema: testSchema})
	if err != nil {
		t.Fatal(err)
	}
	if r.Text != `{"title":"Hi","tags":["a","b"]}` {
		t.Fatalf("text = %s", r.Text)
	}
	var body struct {
		Messages       []Message `json:"messages"`
		ResponseFormat struct {
			Type       string `json:"type"`
			JSONSchema struct {
				Name   string          `json:"name"`
				Strict bool            `json:"strict"`
				Schema json.RawMessage `json:"schema"`
			} `json:"json_schema"`
		} `json:"response_format"`
	}
	if err := json.Unmarshal([]byte(w.last()), &body); err != nil {
		t.Fatal(err)
	}
	rf := body.ResponseFormat
	if rf.Type != "json_schema" || rf.JSONSchema.Name != "greeting" || !rf.JSONSchema.Strict || len(rf.JSONSchema.Schema) == 0 {
		t.Fatalf("response_format = %+v", rf)
	}
	if len(body.Messages) != 1 || body.Messages[0].Content != "hi" {
		t.Fatalf("messages were changed although the provider takes a schema: %+v", body.Messages)
	}
}

func TestStructuredOutputFallsBackToInstructionAndTolerantParse(t *testing.T) {
	w := newWire(t, "Sure! Here it is:\n```json\n{\"title\": \"Hi\", \"tags\": [\"a\", \"b\", \"c\"]}\n```")
	c := New([]Provider{{ID: "groq", BaseURL: w.srv.URL, APIKey: "k", Model: "m"}}, quiet())
	r, err := c.Complete(context.Background(), Request{
		Messages: []Message{{Role: "system", Content: "Be kind."}, {Role: "user", Content: "hi"}},
		Schema:   testSchema,
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.Text != `{"title":"Hi","tags":["a","b","c"]}` {
		t.Fatalf("text = %s", r.Text)
	}
	got := w.last()
	if strings.Contains(got, "response_format") {
		t.Fatalf("a provider without structured output was sent response_format: %s", got)
	}
	var body struct{ Messages []Message }
	_ = json.Unmarshal([]byte(got), &body)
	if len(body.Messages) != 2 || !strings.HasPrefix(body.Messages[0].Content, "Be kind.\n\nReply with one JSON object") {
		t.Fatalf("messages = %+v", body.Messages)
	}
}

func TestInvalidStructuredReplyTriesTheNextProvider(t *testing.T) {
	bad := newWire(t, `{"title":"Hi","tags":["only one"]}`)
	good := newWire(t, `{"title":"Hi","tags":["a","b"]}`)
	c := New([]Provider{
		{ID: "cloudflare", BaseURL: bad.srv.URL, APIKey: "k", Model: "m"},
		{ID: "groq", BaseURL: good.srv.URL, APIKey: "k", Model: "m"},
	}, quiet())
	r, err := c.Complete(context.Background(), Request{Messages: hi.Messages, Schema: testSchema})
	if err != nil || r.Provider != "groq" {
		t.Fatalf("reply = %+v err = %v", r, err)
	}
	if !c.Status()[0].Available {
		t.Fatal("a reply that did not validate must not bench the provider")
	}

	only := New([]Provider{{ID: "cloudflare", BaseURL: bad.srv.URL, APIKey: "k", Model: "m"}}, quiet())
	if _, err := only.Complete(context.Background(), Request{Messages: hi.Messages, Schema: testSchema}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestSchemaValidation(t *testing.T) {
	for _, tc := range []struct {
		in string
		ok bool
	}{
		{`{"title":"x","tags":["a","b"]}`, true},
		{`noise {"title":"x","tags":["a","b"]} trailing`, true},
		{`{"title":"x"}`, false},
		{`{"title":3,"tags":["a","b"]}`, false},
		{`{"title":"x","tags":["a","b","c","d"]}`, false},
		{`{"title":"x","tags":[1,2]}`, false},
		{`no json here`, false},
		{`{"title":"x", broken`, false},
	} {
		_, err := testSchema.Extract(tc.in)
		if (err == nil) != tc.ok {
			t.Errorf("Extract(%q) err = %v, want ok=%v", tc.in, err, tc.ok)
		}
	}
}

func TestCostEstimate(t *testing.T) {
	if got := EstimateCostUSD("openai", "gpt-5-nano", 1_000_000, 1_000_000); math.Abs(got-0.45) > 1e-9 {
		t.Fatalf("gpt-5-nano 1M+1M = %v, want 0.45", got)
	}
	if got := EstimateCostUSD("openai", "gpt-5-nano-2025-08-07", 2000, 1000); math.Abs(got-0.0005) > 1e-9 {
		t.Fatalf("dated snapshot = %v", got)
	}
	if got := EstimateCostUSD("groq", "openai/gpt-oss-20b", 5000, 5000); got != 0 {
		t.Fatalf("free provider cost %v", got)
	}
	if p := PriceFor("custom", "mystery-model"); p != unknownPrice {
		t.Fatalf("unknown model priced %v", p)
	}
}
