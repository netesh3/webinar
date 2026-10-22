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
	// Month is this calendar month's (UTC) AI use, against the caps.
	Month AIMonthUsage `json:"month"`
}

// AI feature names, as recorded in ai_usage and reported per feature.
const (
	AIFeatureSalesChat    = "sales_chat"
	AIFeatureWebinarSetup = "webinar_setup"
)

// AIFeatureUsage is one AI feature's calls this month.
type AIFeatureUsage struct {
	Feature string `json:"feature"`
	// Calls counts every call; Failed the ones no provider answered.
	Calls            int     `json:"calls"`
	Failed           int     `json:"failed"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	CostUSD          float64 `json:"costUsd"`
}

/* AIMonthUsage is month-to-date spend, estimated from token counts. The caps are what
 * the server refuses past: MonthlyCapUSD for the instance, HostMonthlyCapUSD for any
 * one host. */
type AIMonthUsage struct {
	// Since is the start of the month (RFC 3339, UTC).
	Since             string           `json:"since"`
	SpendUSD          float64          `json:"spendUsd"`
	MonthlyCapUSD     float64          `json:"monthlyCapUsd"`
	HostMonthlyCapUSD float64          `json:"hostMonthlyCapUsd"`
	Features          []AIFeatureUsage `json:"features"`
}
