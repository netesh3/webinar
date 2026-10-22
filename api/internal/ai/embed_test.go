package ai

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// The embedder batches, keeps input order, prices the model, and benches a failing endpoint.
func TestOpenAIEmbedderBatchesInOrder(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/embeddings" || r.Header.Get("Authorization") != "Bearer sk-t" {
			t.Errorf("path %s auth %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var req embedRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Model != EmbedModel || req.Dimensions != EmbedDims || len(req.Input) > EmbedBatch {
			t.Errorf("request = %s %d %d", req.Model, req.Dimensions, len(req.Input))
		}
		type item struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		}
		var data []item
		// Reversed, to prove the order is the indexes', not the reply's.
		for i := len(req.Input) - 1; i >= 0; i-- {
			v := make([]float32, EmbedDims)
			v[0] = float32(len(req.Input[i]))
			data = append(data, item{Index: i, Embedding: v})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data, "usage": map[string]int{"prompt_tokens": 10 * len(req.Input)}})
	}))
	defer srv.Close()

	e := NewOpenAIEmbedder("openai", srv.URL+"/v1/", "sk-t")
	inputs := make([]string, EmbedBatch+3)
	for i := range inputs {
		inputs[i] = strings.Repeat("x", i+1)
	}
	got, err := e.Embed(context.Background(), inputs)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(got.Vectors) != len(inputs) || got.PromptTokens != 10*len(inputs) {
		t.Fatalf("calls %d vectors %d tokens %d", calls.Load(), len(got.Vectors), got.PromptTokens)
	}
	for i, v := range got.Vectors {
		if int(v[0]) != i+1 {
			t.Fatalf("vector %d is input %v's", i, v[0])
		}
	}
	if c := EstimateCostUSD("openai", EmbedModel, 1_000_000, 0); math.Abs(c-0.02) > 1e-9 {
		t.Fatalf("cost per million = %v", c)
	}
}

func TestOpenAIEmbedderBenchesOnFailure(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	e := NewOpenAIEmbedder("openai", srv.URL, "k")
	for i := range 3 {
		_, err := e.Embed(context.Background(), []string{"a"})
		if !errors.Is(err, ErrUnavailable) || (i > 0) != errors.Is(err, ErrBenched) {
			t.Fatalf("call %d: err = %v", i, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d; a benched endpoint must not be asked again", calls.Load())
	}
	if _, err := (NoEmbedder{}).Embed(context.Background(), []string{"a"}); !errors.Is(err, ErrUnavailable) {
		t.Fatal("NoEmbedder answered")
	}
}

func TestEmbedReplyShapeIsChecked(t *testing.T) {
	r := embedResponse{}
	r.Data = append(r.Data, struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	}{Index: 0, Embedding: []float32{1, 2}})
	if _, err := orderVectors(r, 1); err == nil {
		t.Fatal("a short vector was accepted")
	}
	if _, err := orderVectors(embedResponse{}, 1); err == nil {
		t.Fatal("a missing vector was accepted")
	}
	if got := ClipEmbedInput("  "); got != "." {
		t.Fatalf("empty input = %q", got)
	}
}
