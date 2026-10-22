/* AI usage: one row per call to a model, and the switch that lets a host make them.
 *
 * ai_usage is what the monthly caps are counted from (AI_MONTHLY_USD for the instance,
 * AI_HOST_MONTHLY_USD per host) and what /api/admin/ai reports. cost_usd is an
 * estimate from the provider's own token counts and internal/ai/price.go, not an
 * invoice. host_id is null for calls no host made (the home page's sales chat), and
 * set null rather than deleted when the account goes, so the month's spend stays true.
 * ok is false for a call no provider answered: it cost nothing, but an operator wants
 * to see it.
 */
CREATE TABLE ai_usage (
    id                bigserial PRIMARY KEY,
    created_at        timestamptz NOT NULL DEFAULT now(),
    feature           text NOT NULL,
    host_id           uuid REFERENCES users(id) ON DELETE SET NULL,
    provider          text NOT NULL DEFAULT '',
    model             text NOT NULL DEFAULT '',
    prompt_tokens     integer NOT NULL DEFAULT 0,
    completion_tokens integer NOT NULL DEFAULT 0,
    cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
    ok                boolean NOT NULL DEFAULT true
);

CREATE INDEX ai_usage_created ON ai_usage (created_at);
CREATE INDEX ai_usage_host_created ON ai_usage (host_id, created_at) WHERE host_id IS NOT NULL;

/* The "ai" switch (types.FeatureAI) starts ON in every tier, like the whiteboard: the
 * spend it can cause is bounded by the caps above, and a host who should not have it
 * is turned off for their account (users.features_off) or their tier. */
INSERT INTO plan_features (plan, feature, enabled)
SELECT p, 'ai', true
  FROM unnest(ARRAY['', 'professional', 'business', 'enterprise']) AS p
ON CONFLICT (plan, feature) DO NOTHING;
