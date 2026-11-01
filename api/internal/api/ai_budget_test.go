package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/api"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/types"
)

/* The AI budget: every call recorded, and the monthly caps enforced, against a fake
 * OpenAI that bills 100,000 prompt and 100,000 completion tokens per answer — $0.045 on
 * gpt-5-nano, so a cap of a few cents is crossed in a couple of calls. */

type fakeOpenAI struct {
	mu     sync.Mutex
	calls  int
	reply  string
	bodies []map[string]any
	// bySchema, when it names a call's structured-output schema, is that call's reply instead.
	bySchema map[string]string
}

func newFakeOpenAI(t *testing.T, reply string) (*fakeOpenAI, *httptest.Server) {
	f := &fakeOpenAI{reply: reply}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.calls++
		f.bodies = append(f.bodies, body)
		reply := f.reply
		if rf, _ := body["response_format"].(map[string]any); rf != nil {
			if js, _ := rf["json_schema"].(map[string]any); js != nil {
				if r, ok := f.bySchema[fmt.Sprint(js["name"])]; ok {
					reply = r
				}
			}
		}
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"role": "assistant", "content": reply}}},
			"usage":   map[string]int{"prompt_tokens": 100_000, "completion_tokens": 100_000},
		})
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeOpenAI) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// schemaOf is a request body's structured-output schema name ("" for none).
func schemaOf(body map[string]any) string {
	if rf, _ := body["response_format"].(map[string]any); rf != nil {
		if js, _ := rf["json_schema"].(map[string]any); js != nil {
			return fmt.Sprint(js["name"])
		}
	}
	return ""
}

// callsFor is how many calls asked for the schema called name.
func (f *fakeOpenAI) callsFor(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, b := range f.bodies {
		if schemaOf(b) == name {
			n++
		}
	}
	return n
}

// lastBodyFor is the last call that asked for the schema called name.
func (f *fakeOpenAI) lastBodyFor(name string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.bodies) - 1; i >= 0; i-- {
		if schemaOf(f.bodies[i]) == name {
			return f.bodies[i]
		}
	}
	return nil
}

func (f *fakeOpenAI) lastBody() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) == 0 {
		return nil
	}
	return f.bodies[len(f.bodies)-1]
}

// aiHarness is a harness whose only provider is the fake, styled as gpt-5-nano.
func aiHarness(t *testing.T, reply string, tweak func(*config.Config)) (*harness, *fakeOpenAI) {
	t.Helper()
	model, srv := newFakeOpenAI(t, reply)
	h := newHarness(t, func(c *config.Config) {
		c.AIProviders = []config.AIProvider{{
			ID: "openai", BaseURL: srv.URL, APIKey: "sk-test", Model: "gpt-5-nano",
			Style: "openai-reasoning", StructuredOutput: true,
		}}
		if tweak != nil {
			tweak(c)
		}
	})
	return h, model
}

func (h *harness) adminAI() types.AIStatus {
	h.t.Helper()
	if _, _, err := h.store.PromoteAdmins(h.t.Context(), []string{"neeraj@acme.dev"}); err != nil {
		h.t.Fatalf("promote admin: %v", err)
	}
	h.login("neeraj@acme.dev")
	res, raw := h.do(http.MethodGet, "/api/admin/ai", nil)
	if res.StatusCode != http.StatusOK {
		h.t.Fatalf("admin ai: %d %s", res.StatusCode, raw)
	}
	var st types.AIStatus
	h.decode(raw, &st)
	return st
}

var aiHello = ai.Request{Messages: []ai.Message{{Role: "user", Content: "hello"}}}

func TestAIUsageIsRecordedAndReported(t *testing.T) {
	h, model := aiHarness(t, "hi there", nil)
	ctx := context.Background()
	host, err := h.store.UserByEmail(ctx, "priya@acme.dev")
	if err != nil {
		t.Fatal(err)
	}
	// The backstop at the point of spend (1 Nov 2026): only a host with ai reaches the model.
	forceFeature(t, h, host.ID, types.FeatureAI, true)

	r, err := api.AIComplete(h.server, ctx, types.AIFeatureWebinarSetup, host.ID, aiHello)
	if err != nil || r.Text != "hi there" {
		t.Fatalf("reply = %+v err = %v", r, err)
	}
	if body := model.lastBody(); body["max_completion_tokens"] == nil || body["temperature"] != nil || body["reasoning_effort"] != "minimal" {
		t.Fatalf("gpt-5 body = %v", body)
	}
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureSalesChat, "", aiHello); err != nil {
		t.Fatal(err)
	}

	st := h.adminAI()
	m := st.Month
	if m.MonthlyCapUSD != 20 || m.HostMonthlyCapUSD != 2 || m.Since == "" {
		t.Fatalf("month = %+v", m)
	}
	if math.Abs(m.SpendUSD-0.09) > 1e-6 {
		t.Fatalf("spend = %v, want 0.09 (two calls at $0.045)", m.SpendUSD)
	}
	if len(m.Features) != 2 {
		t.Fatalf("features = %+v", m.Features)
	}
	for _, f := range m.Features {
		if f.Calls != 1 || f.Failed != 0 || f.PromptTokens != 100_000 || f.CompletionTokens != 100_000 || math.Abs(f.CostUSD-0.045) > 1e-6 {
			t.Errorf("feature usage = %+v", f)
		}
	}
}

func TestAIHostCapRefusesThatHostOnly(t *testing.T) {
	h, model := aiHarness(t, "hi", func(c *config.Config) { c.AIHostMonthlyUSD = 0.05 })
	ctx := context.Background()
	coach, _ := h.store.UserByEmail(ctx, "priya@acme.dev")
	other, _ := h.store.UserByEmail(ctx, "neeraj@acme.dev")
	forceFeature(t, h, coach.ID, types.FeatureAI, true)
	forceFeature(t, h, other.ID, types.FeatureAI, true)

	// $0.045, then $0.09: the call that crosses the line is allowed, the next is not.
	for i := 0; i < 2; i++ {
		if _, err := api.AIComplete(h.server, ctx, types.AIFeatureWebinarSetup, coach.ID, aiHello); err != nil {
			t.Fatalf("call %d: %v", i+1, err)
		}
	}
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureWebinarSetup, coach.ID, aiHello); !api.IsAILimit(err) {
		t.Fatalf("over the host cap: err = %v", err)
	}
	if n := model.callCount(); n != 2 {
		t.Fatalf("model called %d times; a refused call must not reach it", n)
	}
	// Another host has their own allowance.
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureWebinarSetup, other.ID, aiHello); err != nil {
		t.Fatalf("another host: %v", err)
	}
}

func TestAIGlobalCapRefusesEveryone(t *testing.T) {
	h, _ := aiHarness(t, "hi", func(c *config.Config) { c.AIMonthlyUSD = 0.04 })
	ctx := context.Background()
	coach, _ := h.store.UserByEmail(ctx, "priya@acme.dev")
	forceFeature(t, h, coach.ID, types.FeatureAI, true)
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureSalesChat, "", aiHello); err != nil {
		t.Fatal(err)
	}
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureWebinarSetup, coach.ID, aiHello); !api.IsAILimit(err) {
		t.Fatalf("over the global cap: err = %v", err)
	}
	if _, err := api.AIComplete(h.server, ctx, types.AIFeatureSalesChat, "", aiHello); !api.IsAILimit(err) {
		t.Fatalf("sales chat over the global cap: err = %v", err)
	}
}

func TestAIFailedCallIsCountedAndFree(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	h := newHarness(t, func(c *config.Config) {
		c.AIProviders = []config.AIProvider{{ID: "openai", BaseURL: srv.URL, APIKey: "k", Model: "gpt-5-nano"}}
	})
	if _, err := api.AIComplete(h.server, context.Background(), types.AIFeatureSalesChat, "", aiHello); err == nil {
		t.Fatal("a provider that is down answered")
	}
	m := h.adminAI().Month
	if m.SpendUSD != 0 || len(m.Features) != 1 || m.Features[0].Calls != 1 || m.Features[0].Failed != 1 {
		t.Fatalf("month = %+v", m)
	}
}
