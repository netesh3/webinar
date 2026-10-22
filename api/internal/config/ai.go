package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

/* Which model providers the AI features may use, in the order they are tried.
 *
 * The same shape as LIVEKIT_PROJECTS, for the same reason: a free allowance runs out, and
 * when it does the next one should take over without a deploy. Unlike LiveKit, the switch
 * is automatic and per request — see internal/ai — so the order here is simply the order
 * of preference.
 *
 * Two spellings, one result.
 *
 * The short one is a pair of variables per provider, read in a fixed order:
 *
 *   OPENAI_API_KEY [OPENAI_MODEL]                                          tried first
 *   CLOUDFLARE_AI_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN [CLOUDFLARE_AI_MODEL]
 *   GROQ_API_KEY [GROQ_MODEL]
 *   OPENROUTER_API_KEY [OPENROUTER_MODEL]
 *   OLLAMA_URL [OLLAMA_MODEL]                                              tried last
 *
 * Set the ones you have; unset ones are not in the chain.
 *
 * OpenAI is first because it is the one that is paid: gpt-5-nano costs a fraction of a
 * cent per answer and writes noticeably better copy than the free models, and the
 * monthly caps (AI_MONTHLY_USD, AI_HOST_MONTHLY_USD, see Config) bound what it can
 * spend. The free chain behind it answers when OpenAI is down or refuses.
 *
 * Request style. OpenAI's reasoning models (gpt-5*, o1/o3/o4) take a different body
 * (max_completion_tokens, no temperature, reasoning_effort). A provider on
 * api.openai.com with such a model gets that style automatically; any other provider
 * can ask for it with "style":"openai-reasoning" in AI_PROVIDERS. "structuredOutput":
 * true says a provider honours response_format json_schema; api.openai.com always does.
 *
 * The long one replaces all of that with an explicit list, for a different order, a
 * second Cloudflare account, or any other OpenAI-compatible endpoint:
 *
 *   AI_PROVIDERS=[
 *     {"id":"cloudflare","baseUrl":"https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai/v1",
 *      "apiKey":"…","model":"@cf/meta/llama-3.1-8b-instruct-fp8-fast"},
 *     {"id":"groq","baseUrl":"https://api.groq.com/openai/v1","apiKey":"gsk_…","model":"openai/gpt-oss-20b"}
 *   ]
 *
 * When AI_PROVIDERS is set the short variables are ignored, not merged, for the reason
 * LIVEKIT_PROJECTS gives: there is no merge an operator would predict.
 *
 * Nothing set at all is valid. The AI features then report that they are off, and the
 * sales chat goes straight to a person.
 */

// AIProvider is one OpenAI-compatible chat endpoint.
type AIProvider struct {
	ID       string `json:"id"`
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey,omitempty"`
	Model    string `json:"model"`
	Disabled bool   `json:"disabled,omitempty"`
	// Style is "" / "chat" or "openai-reasoning" (internal/ai). Empty is decided
	// from the endpoint and model; see normaliseAIProviders.
	Style string `json:"style,omitempty"`
	// StructuredOutput: the provider honours response_format json_schema.
	StructuredOutput bool `json:"structuredOutput,omitempty"`
}

// The request styles, as internal/ai names them.
const (
	aiStyleChat      = "chat"
	aiStyleReasoning = "openai-reasoning"
)

/* Default models, chosen for a short, factual sales answer at the lowest cost.
 *
 * Model catalogues change; these are defaults, not requirements. Set the *_MODEL variable
 * to whatever the provider's dashboard currently lists. A name the provider does not know
 * shows up as "model or endpoint not found" in the log and on /api/admin/ai, and the chain
 * moves on to the next provider rather than failing the visitor.
 */
/* Cloudflare's default is the fp8-fast build of Llama 3.1 8B: the same model, quantised,
 * at about a fifth of the Neurons per reply (a sales turn is ~2,000 prompt tokens, which
 * fp8-fast prices at 4,119/M against 25,608/M). On the free 10,000 Neurons a day that is
 * roughly 800 replies instead of 160. */
const (
	defaultOpenAIModel     = "gpt-5-nano"
	defaultCloudflareModel = "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
	defaultGroqModel       = "openai/gpt-oss-20b"
	defaultOllamaModel     = "qwen2.5:7b"
)

/* OpenRouter's default is its Free Models Router, not one model.
 *
 * Single free models come and go month to month, and a pinned one that stopped being
 * free would start spending credits. openrouter/free only ever picks from the models
 * that are free right now (at random, among those that can serve the request), so it
 * neither breaks when the list changes nor costs anything. The trade-off is that the
 * model behind it varies; set OPENROUTER_MODEL to a specific ":free" id to pin one.
 */
const defaultOpenRouterModel = "openrouter/free"

func loadAIProviders() ([]AIProvider, error) {
	if raw := strings.TrimSpace(os.Getenv("AI_PROVIDERS")); raw != "" {
		var list []AIProvider
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&list); err != nil {
			return nil, fmt.Errorf("AI_PROVIDERS is not a valid JSON array of providers: %w", err)
		}
		return normaliseAIProviders(list), nil
	}

	var list []AIProvider
	if key := env("OPENAI_API_KEY", ""); key != "" {
		list = append(list, AIProvider{
			ID: "openai", BaseURL: openAIBaseURL,
			APIKey: key, Model: env("OPENAI_MODEL", defaultOpenAIModel),
		})
	}
	if acct, tok := env("CLOUDFLARE_AI_ACCOUNT_ID", ""), env("CLOUDFLARE_AI_TOKEN", ""); acct != "" || tok != "" {
		list = append(list, AIProvider{
			ID:      "cloudflare",
			BaseURL: "https://api.cloudflare.com/client/v4/accounts/" + url.PathEscape(acct) + "/ai/v1",
			APIKey:  tok,
			Model:   env("CLOUDFLARE_AI_MODEL", defaultCloudflareModel),
		})
		if acct == "" || tok == "" {
			return nil, errors.New("CLOUDFLARE_AI_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN must be set together")
		}
	}
	if key := env("GROQ_API_KEY", ""); key != "" {
		list = append(list, AIProvider{
			ID: "groq", BaseURL: "https://api.groq.com/openai/v1",
			APIKey: key, Model: env("GROQ_MODEL", defaultGroqModel),
		})
	}
	if key := env("OPENROUTER_API_KEY", ""); key != "" {
		list = append(list, AIProvider{
			ID: "openrouter", BaseURL: "https://openrouter.ai/api/v1",
			APIKey: key, Model: env("OPENROUTER_MODEL", defaultOpenRouterModel),
		})
	}
	if base := env("OLLAMA_URL", ""); base != "" {
		list = append(list, AIProvider{
			ID: "ollama", BaseURL: strings.TrimRight(base, "/") + "/v1",
			Model: env("OLLAMA_MODEL", defaultOllamaModel),
		})
	}
	return normaliseAIProviders(list), nil
}

func normaliseAIProviders(list []AIProvider) []AIProvider {
	out := make([]AIProvider, 0, len(list))
	for _, p := range list {
		p.ID = strings.ToLower(strings.TrimSpace(p.ID))
		p.BaseURL = strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
		p.APIKey = strings.TrimSpace(p.APIKey)
		p.Model = strings.TrimSpace(p.Model)
		p.Style = strings.ToLower(strings.TrimSpace(p.Style))
		if u, err := url.Parse(p.BaseURL); err == nil && strings.EqualFold(u.Hostname(), "api.openai.com") {
			p.StructuredOutput = true
			if p.Style == "" && isOpenAIReasoningModel(p.Model) {
				p.Style = aiStyleReasoning
			}
		}
		out = append(out, p)
	}
	return out
}

const openAIBaseURL = "https://api.openai.com/v1"

// isOpenAIReasoningModel: gpt-5 and its variants, and the o-series (o1, o3, o4-mini…).
func isOpenAIReasoningModel(model string) bool {
	m := strings.ToLower(model)
	if strings.HasPrefix(m, "gpt-5") {
		return true
	}
	return len(m) >= 2 && m[0] == 'o' && m[1] >= '1' && m[1] <= '9'
}

/* validateAIProviders refuses at boot what would otherwise fail at a visitor's first
 * question, where the only symptom is the chat handing everyone to a person. */
func validateAIProviders(list []AIProvider, dev bool) error {
	var errs []error
	seen := map[string]int{}
	for i, p := range list {
		where := fmt.Sprintf("AI provider %d", i)
		if p.ID != "" {
			where = fmt.Sprintf("%s (%q)", where, p.ID)
		}
		switch {
		case p.ID == "":
			errs = append(errs, fmt.Errorf("%s: id is required", where))
		case !projectID.MatchString(p.ID):
			errs = append(errs, fmt.Errorf("%s: id must be 1-32 characters of a-z, 0-9, _ or -", where))
		default:
			if first, dup := seen[p.ID]; dup {
				errs = append(errs, fmt.Errorf("%s: duplicate id, already used by provider %d", where, first))
			} else {
				seen[p.ID] = i
			}
		}
		if p.Model == "" {
			errs = append(errs, fmt.Errorf("%s: model is required", where))
		}
		if p.Style != "" && p.Style != aiStyleChat && p.Style != aiStyleReasoning {
			errs = append(errs, fmt.Errorf("%s: style must be %q or %q", where, aiStyleChat, aiStyleReasoning))
		}
		u, err := url.Parse(p.BaseURL)
		switch {
		case p.BaseURL == "" || err != nil || u.Host == "":
			errs = append(errs, fmt.Errorf("%s: baseUrl must be an absolute URL", where))
		case u.Scheme != "https" && !(u.Scheme == "http" && (dev || isPrivateHost(u.Hostname()))):
			// The key travels in a header. Plain http is for a model on this machine or
			// this network (Ollama), never across the internet.
			errs = append(errs, fmt.Errorf("%s: baseUrl must be https:// unless it is a local or private address", where))
		}
		if p.APIKey == "" && u != nil && !isPrivateHost(u.Hostname()) {
			errs = append(errs, fmt.Errorf("%s: apiKey is required for a hosted provider", where))
		}
	}
	return errors.Join(errs...)
}

func isPrivateHost(h string) bool {
	h = strings.ToLower(h)
	if h == "localhost" || h == "host.docker.internal" || strings.HasSuffix(h, ".internal") || strings.HasSuffix(h, ".local") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

// EnabledAIProviders is the chain, in order, without the ones switched off.
func (c Config) EnabledAIProviders() []AIProvider {
	out := make([]AIProvider, 0, len(c.AIProviders))
	for _, p := range c.AIProviders {
		if !p.Disabled {
			out = append(out, p)
		}
	}
	return out
}

// describeAIProviders is the boot-log summary: ids and models, never a key.
func describeAIProviders(list []AIProvider) string {
	if len(list) == 0 {
		return "off"
	}
	parts := make([]string, 0, len(list))
	for _, p := range list {
		s := p.ID + ":" + p.Model
		if p.Disabled {
			s += "(off)"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, ",")
}
