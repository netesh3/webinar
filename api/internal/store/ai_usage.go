package store

import (
	"context"
	"time"

	"github.com/netkumar/webcast/api/types"
)

/* AI usage (migrations/0126): one row per model call, counted for the monthly caps and
 * reported on /api/admin/ai. */

// AIUsage is one call. HostID empty means no host made it (the sales chat).
type AIUsage struct {
	Feature          string
	HostID           string
	Provider         string
	Model            string
	PromptTokens     int
	CompletionTokens int
	CostUSD          float64
	OK               bool
}

// RecordAIUsage writes one call.
func (s *Store) RecordAIUsage(ctx context.Context, u AIUsage) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ai_usage (feature, host_id, provider, model, prompt_tokens, completion_tokens, cost_usd, ok)
		VALUES ($1, NULLIF($2, '')::uuid, $3, $4, $5, $6, $7, $8)`,
		u.Feature, u.HostID, u.Provider, u.Model, u.PromptTokens, u.CompletionTokens, u.CostUSD, u.OK)
	return err
}

/* AISpendSince is the estimated spend since a moment: the whole instance's, and this
 * host's (zero when hostID is empty). One query, because every gated call needs both. */
func (s *Store) AISpendSince(ctx context.Context, since time.Time, hostID string) (total, host float64, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT coalesce(sum(cost_usd), 0)::float8,
		       coalesce(sum(cost_usd) FILTER (WHERE $2 <> '' AND host_id::text = $2), 0)::float8
		  FROM ai_usage
		 WHERE created_at >= $1`, since, hostID).Scan(&total, &host)
	return total, host, err
}

// AIUsageByFeature is the calls since a moment, per feature, by name.
func (s *Store) AIUsageByFeature(ctx context.Context, since time.Time) ([]types.AIFeatureUsage, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT feature, count(*)::int, count(*) FILTER (WHERE NOT ok)::int,
		       coalesce(sum(prompt_tokens), 0)::bigint, coalesce(sum(completion_tokens), 0)::bigint,
		       coalesce(sum(cost_usd), 0)::float8
		  FROM ai_usage
		 WHERE created_at >= $1
		 GROUP BY feature
		 ORDER BY feature`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []types.AIFeatureUsage{}
	for rows.Next() {
		var f types.AIFeatureUsage
		if err := rows.Scan(&f.Feature, &f.Calls, &f.Failed, &f.PromptTokens, &f.CompletionTokens, &f.CostUSD); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
