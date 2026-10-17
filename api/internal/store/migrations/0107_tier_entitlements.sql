/* Plans decide features; accounts can override.
 *
 * Until now every switch lived on the account (users.features, migrations/0048), so
 * a plan was only an attendee cap. From here:
 *
 *   effective features = what the account's plan includes (plan_features)
 *                        + users.features      (forced on for this account)
 *                        - users.features_off  (forced off for this account)
 *
 * users.features keeps its name and its writers. The one-shot migrations and the
 * operator SQL that append to it (0073, 0087, store.OperatorInstantWebinarSQL) still
 * mean "on for this account", which is exactly a forced-on override, so none of them
 * changes meaning. users.features_off is new: the switch an admin turns off for one
 * account while the plan includes it.
 *
 * Nobody's features change here. Every tier starts with today's defaults (whiteboard
 * on, everything else off), whiteboard is moved out of users.features (the tier now
 * gives it), and an account that had whiteboard turned off gets a forced-off
 * override. Every other key an account has stays as a forced-on override.
 */
CREATE TABLE plan_features (
    plan    text NOT NULL CHECK (plan IN ('', 'professional', 'business', 'enterprise')),
    feature text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    PRIMARY KEY (plan, feature)
);

INSERT INTO plan_features (plan, feature, enabled)
SELECT p, 'whiteboard', true
  FROM unnest(ARRAY['', 'professional', 'business', 'enterprise']) AS p;

ALTER TABLE users ADD COLUMN features_off text[] NOT NULL DEFAULT '{}';

-- store.FeatureOverrideConversionSQL; a store test keeps the two identical.
UPDATE users SET features_off = ARRAY['whiteboard']
 WHERE NOT ('whiteboard' = ANY (features));
UPDATE users SET features = array_remove(features, 'whiteboard')
 WHERE 'whiteboard' = ANY (features);

-- New accounts inherit from their plan instead of being stamped with a key (0099).
ALTER TABLE users ALTER COLUMN features SET DEFAULT '{}';

/* effective_plan is the one place an account's plan is decided. store reads it for
 * the account, the admin list and the attendee ceiling, so a change to what counts
 * as a live subscription is made here and nowhere else. */
CREATE FUNCTION effective_plan(uid uuid) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT s.plan FROM subscriptions s WHERE s.user_id = uid), '')
$$;

/* effective_features applies the rule at the top of this file. Sorted, so the same
 * account always reads back the same list. */
CREATE FUNCTION effective_features(plan text, forced_on text[], forced_off text[]) RETURNS text[]
LANGUAGE sql STABLE AS $$
    SELECT coalesce(array_agg(f ORDER BY f), '{}')
      FROM (
        SELECT pf.feature AS f FROM plan_features pf WHERE pf.plan = $1 AND pf.enabled
        UNION
        SELECT unnest($2)
      ) granted
     WHERE NOT (f = ANY ($3))
$$;
