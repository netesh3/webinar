package types

/* The AI model chain, as an admin sees it.
 *
 * Which provider is answering right now and which have been set aside, so an operator can
 * tell "Cloudflare's free Neurons ran out at 3pm and Groq took over" from "every key is
 * wrong" without reading logs. Keys never appear here. */

// AIProviderStatus is one provider in the chain, in the order it is tried.
type AIProviderStatus struct {
	ID    string `json:"id"`
	Model string `json:"model"`
	// Available is false while the provider is benched after a failure.
	Available bool `json:"available"`
	// BenchedUntil is when it will be tried again (RFC 3339); empty when available.
	BenchedUntil string `json:"benchedUntil,omitempty"`
	// Reason is why it was benched, e.g. "daily quota used up".
	Reason string `json:"reason,omitempty"`
}

// AIStatus is GET /api/admin/ai.
type AIStatus struct {
	// Enabled is false when no provider is configured at all.
	Enabled   bool               `json:"enabled"`
	Providers []AIProviderStatus `json:"providers"`
}
