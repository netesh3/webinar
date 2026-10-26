package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/netkumar/webcast/api/internal/ai"
	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// newAIChain builds the model chain from config, in priority order.
func newAIChain(cfg config.Config, log *slog.Logger) *ai.Chain {
	enabled := cfg.EnabledAIProviders()
	providers := make([]ai.Provider, 0, len(enabled))
	for _, p := range enabled {
		providers = append(providers, ai.Provider{
			ID: p.ID, BaseURL: p.BaseURL, APIKey: p.APIKey, Model: p.Model,
			Style: p.Style, StructuredOutput: p.StructuredOutput,
		})
	}
	chain := ai.New(providers, log)
	chain.SetGroqRequestBudget(cfg.AIGroqMaxRequestTokens)
	if chain.Enabled() {
		ids := make([]string, 0, len(providers))
		for _, p := range providers {
			ids = append(ids, p.ID+":"+p.Model)
		}
		log.Info("ai enabled", "providers_in_order", ids,
			"monthly_cap_usd", cfg.AIMonthlyUSD, "host_monthly_cap_usd", cfg.AIHostMonthlyUSD)
	} else {
		log.Info("ai disabled: set OPENAI_API_KEY (or CLOUDFLARE_AI_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN, GROQ_API_KEY …) to turn it on")
	}
	return chain
}

/* Every AI call goes through aiComplete: the monthly caps are checked before it, and
 * what it cost is recorded after it.
 *
 * The caps are checked against what has already been spent, so the call that crosses
 * one is allowed and the next is refused; with a fraction of a cent per call that
 * overshoot is not worth a reservation scheme. Two calls racing past the line at once
 * overshoot by two calls, for the same reason.
 *
 * A recording failure is logged, not returned: the host already has their answer, and
 * failing it because a usage row did not write would charge them for nothing.
 */

// errAILimit is a cap reached. The handler's sentence is aiLimitMessage.
var errAILimit = errors.New("ai: monthly limit reached")

const aiLimitMessage = "AI limit reached for this month."

// aiMonthStart is the first instant of the current calendar month, UTC.
func aiMonthStart(now time.Time) time.Time {
	now = now.UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// aiComplete is s.ai.Complete for one feature, on behalf of hostID ("" for none).
func (s *Server) aiComplete(ctx context.Context, feature, hostID string, req ai.Request) (ai.Reply, error) {
	if !s.ai.Enabled() {
		return ai.Reply{}, ai.ErrUnavailable
	}
	if err := s.aiCapCheck(ctx, feature, hostID); err != nil {
		return ai.Reply{}, err
	}
	if req.Model == "" {
		req.Model = s.aiModelFor(feature)
	}
	if req.Feature == "" {
		req.Feature = feature
	}
	if req.ModelFor == nil {
		if m := s.aiGroqModelFor(feature); m != "" {
			req.ModelFor = map[string]string{"groq": m}
		}
	}

	reply, callErr := s.ai.Complete(ctx, req)
	usage := store.AIUsage{Feature: feature, HostID: hostID, OK: callErr == nil}
	if callErr == nil {
		usage.Provider, usage.Model = reply.Provider, reply.Model
		usage.PromptTokens, usage.CompletionTokens = reply.PromptTokens, reply.CompletionTokens
		usage.CostUSD = ai.EstimateCostUSD(reply.Provider, reply.Model, reply.PromptTokens, reply.CompletionTokens)
	}
	// Recorded even when the request is gone: the provider has already been paid.
	if err := s.store.RecordAIUsage(context.WithoutCancel(ctx), usage); err != nil {
		s.log.Warn("ai: record usage", "feature", feature, "error", err)
	}
	return reply, callErr
}

/* aiModelFor is the per-feature model: AI_MODEL_HIGHLIGHTS for the clip features (picking
 * highlights, planning reels with their hook titles, writing post text), nothing (the
 * provider's own model, OPENAI_MODEL) for the rest. */
func (s *Server) aiModelFor(feature string) string {
	switch feature {
	case types.AIFeatureHighlights, types.AIFeatureReels, types.AIFeatureClipPosts:
		return s.cfg.AIModelHighlights
	}
	return ""
}

/* aiGroqModelFor is the Groq model for a feature, when Groq answers: the quality tier for
 * what a host reads and keeps, the fast tier for the short, frequent calls inside a live
 * session (config.AIGroqModelQuality and AIGroqModelFast say which is which, and why). A
 * feature not listed here gets the fast tier: cheap is the safe default for something new. */
func (s *Server) aiGroqModelFor(feature string) string {
	switch feature {
	case types.AIFeatureRecap, types.AIFeatureFollowups, types.AIFeatureRepurpose,
		types.AIFeatureHighlights, types.AIFeatureReels, types.AIFeatureClipPosts,
		types.AIFeatureLeads, types.AIFeatureWebinarSetup, types.AIFeatureQACluster:
		return s.cfg.AIGroqModelQuality
	}
	return s.cfg.AIGroqModelFast
}

// aiCapCheck is errAILimit when the instance or the host has spent its month's allowance.
func (s *Server) aiCapCheck(ctx context.Context, feature, hostID string) error {
	total, host, err := s.store.AISpendSince(ctx, aiMonthStart(time.Now()), hostID)
	if err != nil {
		return err
	}
	if total >= s.cfg.AIMonthlyUSD || (hostID != "" && host >= s.cfg.AIHostMonthlyUSD) {
		s.log.Warn("ai: monthly limit reached", "feature", feature, "host", hostID,
			"spent_usd", total, "host_spent_usd", host)
		return errAILimit
	}
	return nil
}

// handleAdminAIStatus is GET /api/admin/ai: which provider is answering, which are
// benched, and what this month has cost.
func (s *Server) handleAdminAIStatus(w http.ResponseWriter, r *http.Request) {
	out := types.AIStatus{Enabled: s.ai.Enabled(), Providers: []types.AIProviderStatus{}}
	for _, p := range s.ai.Status() {
		st := types.AIProviderStatus{ID: p.ID, Model: p.Model, Available: p.Available, Reason: p.Reason}
		if !p.Available {
			st.BenchedUntil = p.BenchedTill.UTC().Format(time.RFC3339)
		}
		out.Providers = append(out.Providers, st)
	}
	since := aiMonthStart(time.Now())
	total, _, err := s.store.AISpendSince(r.Context(), since, "")
	if err != nil {
		s.fail(w, r, "admin ai: spend", err)
		return
	}
	features, err := s.store.AIUsageByFeature(r.Context(), since)
	if err != nil {
		s.fail(w, r, "admin ai: usage", err)
		return
	}
	out.Month = types.AIMonthUsage{
		Since: since.Format(time.RFC3339), SpendUSD: total,
		MonthlyCapUSD: s.cfg.AIMonthlyUSD, HostMonthlyCapUSD: s.cfg.AIHostMonthlyUSD,
		Features: features,
	}
	httpx.JSON(w, http.StatusOK, out)
}
