package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

/* Groq as production's first provider (2026-10-27): the gpt-oss body, per-task models,
 * the schema-refusal retry, and falling back to OpenAI. */

// groqFake answers like Groq: every request is recorded; answer decides the reply.
type groqFake struct {
	srv    *httptest.Server
	mu     sync.Mutex
	bodies []map[string]any
}

func newGroqFake(t *testing.T, answer func(body map[string]any) (int, string)) *groqFake {
	t.Helper()
	g := &groqFake{}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		g.mu.Lock()
		g.bodies = append(g.bodies, body)
		g.mu.Unlock()
		status, text := answer(body)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, text)
	}))
	t.Cleanup(g.srv.Close)
	u, _ := url.Parse(g.srv.URL)
	old := groqHost
	groqHost = u.Hostname()
	t.Cleanup(func() { groqHost = old })
	return g
}

func (g *groqFake) provider(model string) Provider {
	return Provider{ID: "groq", BaseURL: g.srv.URL + "/openai/v1", APIKey: "gsk", Model: model,
		Style: StyleGroqReasoning, StructuredOutput: true}
}

func (g *groqFake) body(i int) map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.bodies[i]
}

func (g *groqFake) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.bodies)
}

func TestGroqGPTOSSBody(t *testing.T) {
	g := newGroqFake(t, func(map[string]any) (int, string) { return 200, ok(`{"title":"Hi","tags":["a","b"]}`) })
	c := New([]Provider{g.provider("openai/gpt-oss-20b")}, quiet())
	r, err := c.Complete(context.Background(), Request{Messages: hi.Messages, Schema: testSchema, MaxTokens: 250})
	if err != nil || r.Provider != "groq" {
		t.Fatalf("reply %+v err %v", r, err)
	}
	b := g.body(0)
	if b["reasoning_effort"] != "low" || b["include_reasoning"] != false {
		t.Errorf("reasoning fields = %v / %v, want low / false", b["reasoning_effort"], b["include_reasoning"])
	}
	if got := b["max_completion_tokens"]; got != float64(250+groqReasoningHeadroom) {
		t.Errorf("max_completion_tokens = %v, want the cap plus the reasoning headroom", got)
	}
	if _, has := b["max_tokens"]; has {
		t.Errorf("max_tokens sent beside max_completion_tokens: %v", b)
	}
	if b["temperature"] == nil {
		t.Errorf("gpt-oss on Groq takes a temperature: %v", b)
	}
	rf, _ := b["response_format"].(map[string]any)
	js, _ := rf["json_schema"].(map[string]any)
	if rf["type"] != "json_schema" || js["strict"] != true {
		t.Errorf("response_format = %v, want strict json_schema", rf)
	}
}

func TestGroqEffortMapping(t *testing.T) {
	for in, want := range map[string]string{"": "low", "minimal": "low", "low": "low", "Medium": "medium", "high": "high"} {
		if got := groqEffort(in); got != want {
			t.Errorf("groqEffort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestModelForPicksTheGroqTierAndFallsBackWhenRefused(t *testing.T) {
	g := newGroqFake(t, func(b map[string]any) (int, string) {
		if b["model"] == "openai/gpt-oss-120b" {
			return 200, ok("from 120b")
		}
		if b["model"] == "openai/gpt-oss-20b" {
			return 200, ok("from 20b")
		}
		return 404, `{"error":{"message":"model not found"}}`
	})
	c := New([]Provider{g.provider("openai/gpt-oss-20b")}, quiet())

	req := hi
	req.ModelFor = map[string]string{"groq": "openai/gpt-oss-120b"}
	req.Model = "gpt-5-mini" // OpenAI's override: never sent to Groq
	r, err := c.Complete(context.Background(), req)
	if err != nil || r.Text != "from 120b" || r.Model != "openai/gpt-oss-120b" {
		t.Fatalf("tier reply %+v err %v", r, err)
	}

	req.ModelFor = map[string]string{"groq": "openai/gpt-oss-typo"}
	r, err = c.Complete(context.Background(), req)
	if err != nil || r.Text != "from 20b" || r.Model != "openai/gpt-oss-20b" {
		t.Fatalf("refused tier should fall back to the provider's own model: %+v err %v", r, err)
	}
	if _, benched := c.isBenched("groq"); benched {
		t.Fatal("a refused tier model benched Groq")
	}
	for i := 0; i < g.count(); i++ {
		if g.body(i)["model"] == "gpt-5-mini" {
			t.Fatal("OpenAI's model override was sent to Groq")
		}
	}
}

func TestGroqSchemaRefusalRetriesAsJSONObject(t *testing.T) {
	g := newGroqFake(t, func(b map[string]any) (int, string) {
		rf, _ := b["response_format"].(map[string]any)
		if rf["type"] == "json_schema" {
			return 400, `{"error":{"message":"invalid json_schema: 'minItems' is not supported","type":"invalid_request_error"}}`
		}
		if rf["type"] == "json_object" {
			return 200, ok("```json\n{\"title\":\"Hi\",\"tags\":[\"a\",\"b\"]}\n```")
		}
		return 500, `{}`
	})
	c := New([]Provider{g.provider("openai/gpt-oss-20b")}, quiet())
	r, err := c.Complete(context.Background(), Request{Messages: hi.Messages, Schema: testSchema})
	if err != nil || r.Text != `{"title":"Hi","tags":["a","b"]}` || r.Provider != "groq" {
		t.Fatalf("reply %+v err %v", r, err)
	}
	if g.count() != 2 {
		t.Fatalf("asked %d times, want the schema then the JSON object", g.count())
	}
	msgs, _ := g.body(1)["messages"].([]any)
	first, _ := msgs[0].(map[string]any)
	if !strings.Contains(first["content"].(string), "JSON Schema") {
		t.Fatalf("the retry should ask in words: %v", first)
	}
	if _, benched := c.isBenched("groq"); benched {
		t.Fatal("a schema refusal benched Groq")
	}
}

func TestGroqFailureFallsBackToOpenAI(t *testing.T) {
	for _, status := range []int{429, 503} {
		g := newGroqFake(t, func(map[string]any) (int, string) { return status, `{"error":{"message":"busy"}}` })
		oa := newFake(t, 200, ok("from openai"))
		var logs bytes.Buffer
		c := New([]Provider{g.provider("openai/gpt-oss-20b"), oa.provider("openai")},
			slog.New(slog.NewTextHandler(&logs, nil)))
		r, err := c.Complete(context.Background(), hi)
		if err != nil || r.Provider != "openai" || r.Text != "from openai" {
			t.Fatalf("status %d: reply %+v err %v", status, r, err)
		}
		if _, benched := c.isBenched("groq"); !benched {
			t.Errorf("status %d: Groq should be benched", status)
		}
		if !strings.Contains(logs.String(), "answered by a fallback provider") {
			t.Errorf("status %d: the fallback is not logged: %s", status, logs.String())
		}
	}
}
