package ai

import "strings"

/* What a reply cost, estimated from the provider's own token counts.
 *
 * An estimate, for the monthly caps and the admin screen, not an invoice: OpenAI's
 * bill is the truth. Prices are US dollars per million tokens, from the provider's
 * price page; a dated snapshot (gpt-5-nano-2025-08-07) prices as its family.
 *
 * The free tiers this chain was built on cost nothing, so they are $0 by provider.
 * A model this table does not know, on a provider that is not one of those, is
 * priced as gpt-5 — the dearest model listed — so an unknown model makes a cap trip
 * early rather than late.
 */

// Price is US dollars per million prompt (In) and completion (Out) tokens.
type Price struct{ In, Out float64 }

var prices = []struct {
	model string
	price Price
}{
	// Longest prefix first: "gpt-5" would otherwise match gpt-5-nano.
	{"gpt-5-nano", Price{0.05, 0.40}},
	{"gpt-5-mini", Price{0.25, 2.00}},
	{"gpt-5", Price{1.25, 10.00}},
}

var unknownPrice = Price{1.25, 10.00}

// freeProviders are the free-tier providers of the short configuration.
var freeProviders = map[string]bool{"cloudflare": true, "groq": true, "openrouter": true, "ollama": true}

// PriceFor is the price this chain assumes for a provider and model.
func PriceFor(providerID, model string) Price {
	if freeProviders[providerID] {
		return Price{}
	}
	m := strings.ToLower(model)
	for _, p := range prices {
		if strings.HasPrefix(m, p.model) {
			return p.price
		}
	}
	return unknownPrice
}

// EstimateCostUSD is what a reply with these token counts cost.
func EstimateCostUSD(providerID, model string, promptTokens, completionTokens int) float64 {
	p := PriceFor(providerID, model)
	return (float64(promptTokens)*p.In + float64(completionTokens)*p.Out) / 1e6
}
