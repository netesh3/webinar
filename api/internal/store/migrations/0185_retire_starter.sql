/* Starter retired (2 Nov 2026). The grandfathered plan of 0179 (the first subscribers'
 * ₹3,999 "Professional": 200 attendees, 3 on stage, 10 GB) goes, and everyone on it moves to
 * Professional (300, 5, 10 GB), which is equal or more on every limit.
 *
 *   1. A switch Starter's tier gave them and Professional's does not (server captions, Google
 *      Drive, anything an admin had put in the Starter tier) becomes their own override, unless
 *      it was turned off for them: nobody loses anything. "On Starter" is the plan they have
 *      now, or a live Starter subscription whose renewal is still to land; a lapsed one is not
 *      given the switches without a plan.
 *   2. Every 'starter' row moves to 'professional': subscriptions, billing_orders,
 *      billing_subscriptions and ai_default_off_undo. Starter's own plan_features and
 *      plan_limits rows go.
 *   3. 'starter' leaves the plan CHECKs.
 *
 * razorpay_plans is left alone: a running Razorpay subscription keeps charging the ₹3,999 (plus
 * GST) it was created with, and its renewals are matched by subscription id, never by price, so
 * they keep the account on Professional (api.handleSubscriptionWebhook). */

-- store.RetireStarterSQL; a store test keeps the two identical.
UPDATE users u
   SET features = u.features || ARRAY(
         SELECT s.feature FROM plan_features s
          WHERE s.plan = 'starter' AND s.enabled
            AND NOT EXISTS (SELECT 1 FROM plan_features p
                             WHERE p.plan = 'professional' AND p.feature = s.feature AND p.enabled)
            AND NOT (s.feature = ANY (u.features)) AND NOT (s.feature = ANY (u.features_off))
          ORDER BY s.feature)
 WHERE effective_plan(u.id) = 'starter'
    OR EXISTS (SELECT 1 FROM subscriptions s
                WHERE s.user_id = u.id AND s.plan = 'starter'
                  AND s.status IN ('trialing', 'active', 'past_due'));
UPDATE subscriptions         SET plan = 'professional' WHERE plan = 'starter';
UPDATE billing_orders        SET plan = 'professional' WHERE plan = 'starter';
UPDATE billing_subscriptions SET plan = 'professional' WHERE plan = 'starter';
UPDATE ai_default_off_undo   SET plan = 'professional' WHERE plan = 'starter';
DELETE FROM plan_features WHERE plan = 'starter';
DELETE FROM plan_limits   WHERE plan = 'starter';

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('basic', 'professional', 'business', 'enterprise'));
ALTER TABLE plan_features DROP CONSTRAINT IF EXISTS plan_features_plan_check;
ALTER TABLE plan_features ADD CONSTRAINT plan_features_plan_check
    CHECK (plan IN ('', 'basic', 'professional', 'business', 'enterprise'));
ALTER TABLE plan_limits DROP CONSTRAINT IF EXISTS plan_limits_plan_check;
ALTER TABLE plan_limits ADD CONSTRAINT plan_limits_plan_check
    CHECK (plan IN ('', 'basic', 'professional', 'business', 'enterprise'));
