package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fake is one provider endpoint whose next answer the test controls.
type fake struct {
	srv    *httptest.Server
	calls  atomic.Int32
	status int
	header map[string]string
	body   string
	// lastAuth / lastModel are what the chain sent.
	lastAuth  atomic.Value
	lastModel atomic.Value
}

func newFake(t *testing.T, status int, body string) *fake {
	t.Helper()
	f := &fake{status: status, body: body}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		f.lastAuth.Store(r.Header.Get("Authorization"))
		var req chatRequest
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &req)
		f.lastModel.Store(req.Model)
		for k, v := range f.header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(f.status)
		_, _ = io.WriteString(w, f.body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func ok(text string) string {
	b, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": text}}},
	})
	return string(b)
}

func (f *fake) provider(id string) Provider {
	return Provider{ID: id, BaseURL: f.srv.URL + "/v1", APIKey: "key-" + id, Model: "model-" + id}
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

var hi = Request{Messages: []Message{{Role: "user", Content: "hi"}}}

func TestFirstProviderAnswers(t *testing.T) {
	cf := newFake(t, 200, ok("Hello from Cloudflare"))
	groq := newFake(t, 200, ok("Hello from Groq"))
	c := New([]Provider{cf.provider("cloudflare"), groq.provider("groq")}, quiet())

	r, err := c.Complete(context.Background(), hi)
	if err != nil {
		t.Fatal(err)
	}
	if r.Provider != "cloudflare" || r.Text != "Hello from Cloudflare" {
		t.Fatalf("reply = %+v", r)
	}
	if groq.calls.Load() != 0 {
		t.Fatal("the fallback was called although the first provider answered")
	}
	if got := cf.lastAuth.Load(); got != "Bearer key-cloudflare" {
		t.Fatalf("Authorization = %v", got)
	}
	if got := cf.lastModel.Load(); got != "model-cloudflare" {
		t.Fatalf("model = %v", got)
	}
}

/* The case this package exists for: Cloudflare's free Neurons run out, the visitor still
 * gets an answer from the next provider, and Cloudflare is not asked again until the daily
 * reset — then it is, without a restart. */
func TestDailyQuotaFallsBackAndBenchesUntilMidnightUTC(t *testing.T) {
	cf := newFake(t, 429, `{"errors":[{"code":4006,"message":"you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan"}],"success":false}`)
	groq := newFake(t, 200, ok("Hello from Groq"))
	c := New([]Provider{cf.provider("cloudflare"), groq.provider("groq")}, quiet())

	now := time.Date(2026, 10, 17, 18, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }

	r, err := c.Complete(context.Background(), hi)
	if err != nil || r.Provider != "groq" {
		t.Fatalf("reply = %+v, err = %v; want groq", r, err)
	}

	// Later the same day: Cloudflare is skipped outright.
	now = now.Add(5 * time.Hour)
	if _, err := c.Complete(context.Background(), hi); err != nil {
		t.Fatal(err)
	}
	if cf.calls.Load() != 1 {
		t.Fatalf("cloudflare called %d times; a provider out of quota must sit out the day", cf.calls.Load())
	}
	st := c.Status()
	if st[0].Available || st[0].Reason != "daily quota used up" {
		t.Fatalf("status = %+v", st[0])
	}
	if want := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC); !st[0].BenchedTill.Equal(want) {
		t.Fatalf("benched till %v, want %v", st[0].BenchedTill, want)
	}

	// Past 00:00 UTC, with the allowance back, Cloudflare is first again.
	now = time.Date(2026, 10, 18, 0, 0, 1, 0, time.UTC)
	cf.status, cf.body = 200, ok("Hello again from Cloudflare")
	r, err = c.Complete(context.Background(), hi)
	if err != nil || r.Provider != "cloudflare" {
		t.Fatalf("after reset: reply = %+v, err = %v; want cloudflare", r, err)
	}
}

func TestRateLimitUsesRetryAfter(t *testing.T) {
	groq := newFake(t, 429, `{"error":{"message":"Rate limit reached on tokens per minute (TPM)","code":"rate_limit_exceeded"}}`)
	groq.header = map[string]string{"Retry-After": "7"}
	local := newFake(t, 200, ok("Hello from Ollama"))
	c := New([]Provider{groq.provider("groq"), local.provider("ollama")}, quiet())
	now := time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }

	if r, err := c.Complete(context.Background(), hi); err != nil || r.Provider != "ollama" {
		t.Fatalf("reply = %+v, err = %v", r, err)
	}
	st := c.Status()[0]
	if st.Reason != "rate limited" || !st.BenchedTill.Equal(now.Add(7*time.Second)) {
		t.Fatalf("a per-minute limit must bench for Retry-After, not the day: %+v", st)
	}
}

func TestBadRequestIsNotBenched(t *testing.T) {
	cf := newFake(t, 400, `{"errors":[{"message":"context too long"}]}`)
	groq := newFake(t, 200, ok("fine"))
	c := New([]Provider{cf.provider("cloudflare"), groq.provider("groq")}, quiet())

	if r, err := c.Complete(context.Background(), hi); err != nil || r.Provider != "groq" {
		t.Fatalf("reply = %+v, err = %v", r, err)
	}
	if !c.Status()[0].Available {
		t.Fatal("a 400 is about the request; the provider must stay available for the next one")
	}
}

func TestEverythingDownIsErrUnavailable(t *testing.T) {
	cf := newFake(t, 503, "down")
	groq := newFake(t, 401, `{"error":"invalid api key"}`)
	c := New([]Provider{cf.provider("cloudflare"), groq.provider("groq")}, quiet())

	if _, err := c.Complete(context.Background(), hi); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	st := c.Status()
	if st[0].Available || st[1].Available {
		t.Fatalf("both should be benched: %+v", st)
	}
	if st[1].Reason != "credentials refused (check the API key)" {
		t.Fatalf("reason = %q", st[1].Reason)
	}
}

func TestUnreachableProviderFallsThrough(t *testing.T) {
	dead := newFake(t, 200, "")
	dead.srv.Close() // connection refused
	groq := newFake(t, 200, ok("still here"))
	c := New([]Provider{dead.provider("cloudflare"), groq.provider("groq")}, quiet())

	if r, err := c.Complete(context.Background(), hi); err != nil || r.Provider != "groq" {
		t.Fatalf("reply = %+v, err = %v", r, err)
	}
}

func TestEmptyAndThinkingRepliesFallThrough(t *testing.T) {
	thinker := newFake(t, 200, ok("<think>the user wants pricing, and I"))
	groq := newFake(t, 200, ok("<think>short</think>\n\nBusiness fits most coaches."))
	c := New([]Provider{thinker.provider("cloudflare"), groq.provider("groq")}, quiet())

	r, err := c.Complete(context.Background(), hi)
	if err != nil {
		t.Fatal(err)
	}
	if r.Provider != "groq" || r.Text != "Business fits most coaches." {
		t.Fatalf("reply = %+v; a cut-off thought is not an answer, and a finished one is stripped", r)
	}
	if !c.Status()[0].Available {
		t.Fatal("an empty reply must not bench the provider")
	}
}

func TestNoProviders(t *testing.T) {
	c := New(nil, quiet())
	if c.Enabled() {
		t.Fatal("enabled with no providers")
	}
	if _, err := c.Complete(context.Background(), hi); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
}
