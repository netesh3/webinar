package ai

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

/* Token-aware routing (budget.go): a request too big for Groq's budget goes straight to
 * OpenAI, Groq is not benched, and small requests stay on Groq. */

func TestEstimateTokensIsCharsOverFourPlusCapAndHeadroom(t *testing.T) {
	text := strings.Repeat("word ", 4000) // 20,000 chars ≈ 5,000 tokens
	req := Request{Messages: []Message{{Role: "system", Content: "be brief"}, {Role: "user", Content: text}}, MaxTokens: 900}
	chat := EstimateTokens(req, Provider{Style: StyleChat})
	want := (len("be brief")+len(text)+3)/4 + 2*perMessageTokens + 900
	if chat != want {
		t.Fatalf("estimate = %d, want %d", chat, want)
	}
	if g := EstimateTokens(req, Provider{Style: StyleGroqReasoning}); g != chat+groqReasoningHeadroom {
		t.Errorf("groq estimate = %d, want the chat estimate plus the reasoning headroom", g)
	}
	// A real tokenizer gives ~4.2 chars/token on English: the estimate should be within ~10%.
	if got, approx := chat-900-8, 20008/4; got < approx*9/10 || got > approx*11/10 {
		t.Errorf("input estimate %d is far from ~%d", got, approx)
	}
	// Zero MaxTokens counts the chain's default reply cap.
	if d := EstimateTokens(Request{Messages: []Message{{Content: "hi"}}}, Provider{}); d != 1+perMessageTokens+300 {
		t.Errorf("default cap estimate = %d", d)
	}
}

func TestOverBudgetSkipsGroqForOpenAIWithoutBenching(t *testing.T) {
	g := newGroqFake(t, func(map[string]any) (int, string) { return 200, ok("from groq") })
	srv, asked := openAIFake(t, "gpt-5-nano")
	u, _ := url.Parse(srv.URL)
	openAIHost = "localhost" // groq's fake is 127.0.0.1; the two must differ
	oai := Provider{ID: "openai", BaseURL: "http://localhost:" + u.Port() + "/v1", Model: "gpt-5-nano", Style: StyleOpenAIReasoning}
	c := New([]Provider{g.provider("openai/gpt-oss-120b"), oai}, quiet())
	c.SetGroqRequestBudget(7000)

	big := Request{Feature: "recap", Messages: []Message{{Role: "user", Content: strings.Repeat("transcript line ", 3000)}}, MaxTokens: 1500}
	r, err := c.Complete(context.Background(), big)
	if err != nil || r.Provider != "openai" {
		t.Fatalf("big request: reply %+v err %v, want openai", r, err)
	}
	if g.count() != 0 {
		t.Errorf("groq was asked %d times for an over-budget request", g.count())
	}
	if len(*asked) != 1 {
		t.Errorf("openai asked %d times, want 1", len(*asked))
	}
	if _, benched := c.isBenched("groq"); benched {
		t.Error("groq benched by a skip; a skip is not a failure")
	}

	small := Request{Feature: "qa_answer", Messages: []Message{{Role: "user", Content: "What time is the replay?"}}, MaxTokens: 250}
	r, err = c.Complete(context.Background(), small)
	if err != nil || r.Provider != "groq" {
		t.Fatalf("small request: reply %+v err %v, want groq", r, err)
	}
}

func TestOverBudgetWithoutOpenAIStillAsksGroq(t *testing.T) {
	g := newGroqFake(t, func(map[string]any) (int, string) { return 200, ok("from groq") })
	c := New([]Provider{g.provider("openai/gpt-oss-120b")}, quiet())
	c.SetGroqRequestBudget(7000)
	big := Request{Messages: []Message{{Role: "user", Content: strings.Repeat("x", 60000)}}, MaxTokens: 1500}
	r, err := c.Complete(context.Background(), big)
	if err != nil || r.Provider != "groq" || g.count() != 1 {
		t.Fatalf("reply %+v err %v asked %d: with no OpenAI, groq must still be tried", r, err, g.count())
	}
}

func TestNoBudgetMeansNoSkip(t *testing.T) {
	g := newGroqFake(t, func(map[string]any) (int, string) { return 200, ok("from groq") })
	srv, _ := openAIFake(t, "gpt-5-nano")
	u, _ := url.Parse(srv.URL)
	openAIHost = "localhost"
	oai := Provider{ID: "openai", BaseURL: "http://localhost:" + u.Port() + "/v1", Model: "gpt-5-nano", Style: StyleOpenAIReasoning}
	c := New([]Provider{g.provider("openai/gpt-oss-120b"), oai}, quiet())
	big := Request{Messages: []Message{{Role: "user", Content: strings.Repeat("x", 60000)}}}
	if r, err := c.Complete(context.Background(), big); err != nil || r.Provider != "groq" {
		t.Fatalf("budget 0: reply %+v err %v, want groq", r, err)
	}
}
