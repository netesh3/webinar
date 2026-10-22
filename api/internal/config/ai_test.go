package config

import (
	"strings"
	"testing"
)

func TestAIProvidersFromShortVariablesKeepTheirOrder(t *testing.T) {
	c := load(t, map[string]string{
		"CLOUDFLARE_AI_ACCOUNT_ID": "acct123",
		"CLOUDFLARE_AI_TOKEN":      "cf-token",
		"GROQ_API_KEY":             "gsk_test",
		"OLLAMA_URL":               "http://localhost:11434",
	})
	got := c.EnabledAIProviders()
	if len(got) != 3 {
		t.Fatalf("providers = %+v", got)
	}
	if got[0].ID != "cloudflare" || got[1].ID != "groq" || got[2].ID != "ollama" {
		t.Fatalf("order = %s, %s, %s; Cloudflare must be tried first", got[0].ID, got[1].ID, got[2].ID)
	}
	if got[0].BaseURL != "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1" {
		t.Errorf("cloudflare baseUrl = %q", got[0].BaseURL)
	}
	if got[0].Model != defaultCloudflareModel || got[1].Model != defaultGroqModel {
		t.Errorf("models = %q, %q", got[0].Model, got[1].Model)
	}
	if got[2].BaseURL != "http://localhost:11434/v1" || got[2].APIKey != "" {
		t.Errorf("ollama = %+v", got[2])
	}
	if s := c.String(); strings.Contains(s, "cf-token") || strings.Contains(s, "gsk_test") {
		t.Errorf("boot line leaks a key: %s", s)
	}
}

func TestNoAIProvidersIsValid(t *testing.T) {
	if c := load(t, map[string]string{}); len(c.AIProviders) != 0 {
		t.Fatalf("providers = %+v", c.AIProviders)
	}
}

func TestOpenRouterDefaultsToTheFreeRouter(t *testing.T) {
	c := load(t, map[string]string{"GROQ_API_KEY": "gsk_test", "OPENROUTER_API_KEY": "sk-or"})
	if len(c.AIProviders) != 2 || c.AIProviders[1].ID != "openrouter" {
		t.Fatalf("providers = %+v", c.AIProviders)
	}
	if got := c.AIProviders[1].Model; got != "openrouter/free" {
		t.Fatalf("model = %q, want openrouter/free", got)
	}
}

func TestAIProvidersRefusesHalfAConfig(t *testing.T) {
	cases := map[string]map[string]string{
		"cloudflare token without account": {"CLOUDFLARE_AI_TOKEN": "x"},
		"bad json":                         {"AI_PROVIDERS": `[{"id":"x",}]`},
		"unknown field":                    {"AI_PROVIDERS": `[{"id":"x","baseUrl":"https://a.b/v1","apiKey":"k","model":"m","key":"typo"}]`},
	}
	for name, vars := range cases {
		t.Run(name, func(t *testing.T) {
			setEnv(t, vars)
			if _, err := Load(); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestAIProvidersRefusesAPlainHTTPKeyOverTheInternet(t *testing.T) {
	setEnv(t, productionEnv(map[string]string{
		"AI_PROVIDERS": `[{"id":"x","baseUrl":"http://api.example.com/v1","apiKey":"k","model":"m"}]`,
	}))
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("err = %v", err)
	}
}

func TestAIProvidersExplicitListWins(t *testing.T) {
	c := load(t, map[string]string{
		"GROQ_API_KEY": "ignored",
		"AI_PROVIDERS": `[{"id":"groq","baseUrl":"https://api.groq.com/openai/v1","apiKey":"k","model":"m"},
		                  {"id":"cloudflare","baseUrl":"https://api.cloudflare.com/client/v4/accounts/a/ai/v1","apiKey":"k","model":"m","disabled":true}]`,
	})
	if len(c.AIProviders) != 2 || c.AIProviders[0].APIKey != "k" {
		t.Fatalf("providers = %+v", c.AIProviders)
	}
	if got := c.EnabledAIProviders(); len(got) != 1 || got[0].ID != "groq" {
		t.Fatalf("enabled = %+v", got)
	}
}

func TestOpenAIIsTriedFirstWithTheReasoningStyle(t *testing.T) {
	c := load(t, map[string]string{"GROQ_API_KEY": "gsk_test", "OPENAI_API_KEY": "sk-test"})
	got := c.EnabledAIProviders()
	if len(got) != 2 || got[0].ID != "openai" || got[1].ID != "groq" {
		t.Fatalf("providers = %+v; OpenAI must be first", got)
	}
	o := got[0]
	if o.BaseURL != "https://api.openai.com/v1" || o.Model != "gpt-5-nano" || o.Style != "openai-reasoning" || !o.StructuredOutput {
		t.Fatalf("openai = %+v", o)
	}
	if got[1].Style != "" || got[1].StructuredOutput {
		t.Fatalf("groq changed style: %+v", got[1])
	}
	if s := c.String(); strings.Contains(s, "sk-test") {
		t.Errorf("boot line leaks a key: %s", s)
	}

	c = load(t, map[string]string{"OPENAI_API_KEY": "sk-test", "OPENAI_MODEL": "gpt-4.1-mini"})
	if p := c.AIProviders[0]; p.Model != "gpt-4.1-mini" || p.Style != "" || !p.StructuredOutput {
		t.Fatalf("a non-reasoning OpenAI model keeps the chat style: %+v", p)
	}
}

func TestAIProvidersStyleFlag(t *testing.T) {
	c := load(t, map[string]string{
		"AI_PROVIDERS": `[{"id":"azure","baseUrl":"https://x.openai.azure.com/openai/v1","apiKey":"k","model":"nano","style":"openai-reasoning","structuredOutput":true}]`,
	})
	if p := c.AIProviders[0]; p.Style != "openai-reasoning" || !p.StructuredOutput {
		t.Fatalf("provider = %+v", p)
	}
	setEnv(t, map[string]string{
		"AI_PROVIDERS": `[{"id":"x","baseUrl":"https://a.b/v1","apiKey":"k","model":"m","style":"fancy"}]`,
	})
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "style") {
		t.Fatalf("err = %v", err)
	}
}

func TestAIMonthlyCaps(t *testing.T) {
	c := load(t, map[string]string{})
	if c.AIMonthlyUSD != 20 || c.AIHostMonthlyUSD != 2 {
		t.Fatalf("defaults = %v / %v", c.AIMonthlyUSD, c.AIHostMonthlyUSD)
	}
	c = load(t, map[string]string{"AI_MONTHLY_USD": "50.5", "AI_HOST_MONTHLY_USD": "0"})
	if c.AIMonthlyUSD != 50.5 || c.AIHostMonthlyUSD != 0 {
		t.Fatalf("caps = %v / %v", c.AIMonthlyUSD, c.AIHostMonthlyUSD)
	}
	setEnv(t, map[string]string{"AI_HOST_MONTHLY_USD": "two"})
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "AI_HOST_MONTHLY_USD") {
		t.Fatalf("err = %v", err)
	}
}
