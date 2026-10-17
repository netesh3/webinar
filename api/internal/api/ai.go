package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

// newAIChain builds the model chain from config, in priority order.
func newAIChain(cfg config.Config, log *slog.Logger) *ai.Chain {
	enabled := cfg.EnabledAIProviders()
	providers := make([]ai.Provider, 0, len(enabled))
	for _, p := range enabled {
		providers = append(providers, ai.Provider{ID: p.ID, BaseURL: p.BaseURL, APIKey: p.APIKey, Model: p.Model})
	}
	chain := ai.New(providers, log)
	if chain.Enabled() {
		ids := make([]string, 0, len(providers))
		for _, p := range providers {
			ids = append(ids, p.ID+":"+p.Model)
		}
		log.Info("ai enabled", "providers_in_order", ids)
	} else {
		log.Info("ai disabled: set CLOUDFLARE_AI_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN (and optionally GROQ_API_KEY) to turn it on")
	}
	return chain
}

// handleAdminAIStatus is GET /api/admin/ai: which provider is answering, and which are benched.
func (s *Server) handleAdminAIStatus(w http.ResponseWriter, r *http.Request) {
	out := types.AIStatus{Enabled: s.ai.Enabled(), Providers: []types.AIProviderStatus{}}
	for _, p := range s.ai.Status() {
		st := types.AIProviderStatus{ID: p.ID, Model: p.Model, Available: p.Available, Reason: p.Reason}
		if !p.Available {
			st.BenchedUntil = p.BenchedTill.UTC().Format(time.RFC3339)
		}
		out.Providers = append(out.Providers, st)
	}
	httpx.JSON(w, http.StatusOK, out)
}
