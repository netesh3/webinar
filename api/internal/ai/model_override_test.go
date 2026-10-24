package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// openAIFake answers like OpenAI, refusing every model but the ones in okModels.
func openAIFake(t *testing.T, okModels ...string) (*httptest.Server, *[]string) {
	t.Helper()
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req chatRequest
		_ = json.Unmarshal(raw, &req)
		asked = append(asked, req.Model)
		for _, m := range okModels {
			if req.Model == m {
				_, _ = io.WriteString(w, ok("from "+m))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"model_not_found"}}`)
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	old := openAIHost
	openAIHost = u.Hostname()
	t.Cleanup(func() { openAIHost = old })
	return srv, &asked
}

func TestModelOverrideAsksOpenAIForThatModel(t *testing.T) {
	srv, asked := openAIFake(t, "gpt-5-nano", "gpt-5-mini")
	c := New([]Provider{{ID: "openai", BaseURL: srv.URL + "/v1", Model: "gpt-5-nano", Style: StyleOpenAIReasoning}}, quiet())
	req := hi
	req.Model = "gpt-5-mini"
	r, err := c.Complete(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if r.Model != "gpt-5-mini" || r.Text != "from gpt-5-mini" || len(*asked) != 1 {
		t.Fatalf("reply = %+v, asked %v", r, *asked)
	}
	// Without the override: the provider's own model.
	r, err = c.Complete(context.Background(), hi)
	if err != nil || r.Model != "gpt-5-nano" {
		t.Fatalf("reply = %+v, err %v", r, err)
	}
}

func TestModelOverrideRefusedFallsBackWithoutBenching(t *testing.T) {
	srv, asked := openAIFake(t, "gpt-5-nano")
	c := New([]Provider{{ID: "openai", BaseURL: srv.URL + "/v1", Model: "gpt-5-nano", Style: StyleOpenAIReasoning}}, quiet())
	req := hi
	req.Model = "gpt-5-typo"
	r, err := c.Complete(context.Background(), req)
	if err != nil || r.Model != "gpt-5-nano" {
		t.Fatalf("reply = %+v, err %v (asked %v)", r, err, *asked)
	}
	if _, benched := c.isBenched("openai"); benched {
		t.Fatal("a refused override benched the provider")
	}
}

func TestModelOverrideIgnoredByOtherProviders(t *testing.T) {
	groq := newFake(t, 200, ok("hello"))
	c := New([]Provider{groq.provider("groq")}, quiet())
	req := hi
	req.Model = "gpt-5-mini"
	r, err := c.Complete(context.Background(), req)
	if err != nil || r.Model != "model-groq" || groq.lastModel.Load() != "model-groq" {
		t.Fatalf("reply = %+v, err %v", r, err)
	}
}

func TestWithModelPicksTheBodyStyle(t *testing.T) {
	p := Provider{ID: "openai", BaseURL: "https://" + openAIHost + "/v1", Model: "gpt-5-nano", Style: StyleOpenAIReasoning}
	if q, ok := p.withModel("gpt-4.1-mini"); !ok || q.Style != StyleChat {
		t.Fatalf("gpt-4.1-mini: %+v %v", q, ok)
	}
	if q, ok := p.withModel("o4-mini"); !ok || q.Style != StyleOpenAIReasoning {
		t.Fatalf("o4-mini: %+v %v", q, ok)
	}
	if _, ok := p.withModel("GPT-5-NANO"); ok {
		t.Fatal("the same model is not an override")
	}
}
