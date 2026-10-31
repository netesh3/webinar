/* Pricing v3 (31 Oct 2026): Basic, Professional, Business and Enterprise, with Starter kept
 * for the subscribers who already have it.
 *
 *   plan          attendees  stage  sold
 *   basic               100      3  yes (new)
 *   professional        300      5  yes (the old Business: ₹9,999)
 *   business            500     10  yes (the old Enterprise's limits, now sold online)
 *   enterprise        1,000    100  contact us
 *   starter             200      3  no: the old Professional (₹3,999), grandfathered
 *
 * The attendee and stage numbers are types.PlanAttendeeCap and PlanStageCap. What changes
 * here is the data that names a plan:
 *
 *   1. Every id moves up one name, so nobody's limits move: an account on the old
 *      Professional is on starter, the old Business is professional, the old Enterprise is
 *      business. subscriptions, billing_orders, billing_subscriptions, plan_features,
 *      plan_limits and ai_default_off_undo are renamed together. razorpay_plans is left alone
 *      on purpose: it is keyed by amount, and a cached Razorpay plan named "Business
 *      (monthly)" must not be reused for Professional at the same ₹9,999; new amounts get new
 *      Razorpay plans by themselves (api.razorpayPlanFor). Running Razorpay subscriptions
 *      keep the amount they were created with, so existing subscribers keep their price.
 *   2. The four plans on sale get their switches (store.TierFeatures): cloud recording on
 *      all four; WhatsApp CRM from Professional; simulive, engagement replay, Zoom and the AI
 *      switches (ai, ai_knowledge, simulive_auto, followup_send, repurpose) from Business.
 *      No plan and Starter keep the tier they had.
 *   3. A subscriber whose tier gave them a switch their new tier leaves out keeps it, as
 *      their own override, unless it was turned off for them. Nobody loses anything.
 *   4. Basic and Enterprise copy the other switches (whiteboard, meetings, captions) from
 *      their neighbours, Professional and Business.
 *   5. clips, instant_webinar and hls_delivery leave every tier: highlights and reels are
 *      not sold on any plan, and instant sessions and HLS delivery are an admin's switches
 *      for one host (types.Feature.PerHost). Overrides an admin gave a host stay.
 *   6. Recording storage for Basic (5 GB) and Enterprise (500 GB).
 */
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN ('basic', 'professional', 'business', 'enterprise', 'starter'));
ALTER TABLE plan_features DROP CONSTRAINT IF EXISTS plan_features_plan_check;
ALTER TABLE plan_features ADD CONSTRAINT plan_features_plan_check
    CHECK (plan IN ('', 'basic', 'professional', 'business', 'enterprise', 'starter'));
ALTER TABLE plan_limits DROP CONSTRAINT IF EXISTS plan_limits_plan_check;
ALTER TABLE plan_limits ADD CONSTRAINT plan_limits_plan_check
    CHECK (plan IN ('', 'basic', 'professional', 'business', 'enterprise', 'starter'));

-- store.PricingV3SQL; a store test keeps the two identical.
-- 1. Plan ids move up one name, so every subscriber keeps exactly the limits they have:
--    professional (200 attendees) -> starter, business (300) -> professional,
--    enterprise (500) -> business. In this order, so no id is ever held by two tiers at once.
UPDATE subscriptions         SET plan = 'starter'      WHERE plan = 'professional';
UPDATE subscriptions         SET plan = 'professional' WHERE plan = 'business';
UPDATE subscriptions         SET plan = 'business'     WHERE plan = 'enterprise';
UPDATE billing_orders        SET plan = 'starter'      WHERE plan = 'professional';
UPDATE billing_orders        SET plan = 'professional' WHERE plan = 'business';
UPDATE billing_orders        SET plan = 'business'     WHERE plan = 'enterprise';
UPDATE billing_subscriptions SET plan = 'starter'      WHERE plan = 'professional';
UPDATE billing_subscriptions SET plan = 'professional' WHERE plan = 'business';
UPDATE billing_subscriptions SET plan = 'business'     WHERE plan = 'enterprise';
UPDATE plan_features         SET plan = 'starter'      WHERE plan = 'professional';
UPDATE plan_features         SET plan = 'professional' WHERE plan = 'business';
UPDATE plan_features         SET plan = 'business'     WHERE plan = 'enterprise';
UPDATE plan_limits           SET plan = 'starter'      WHERE plan = 'professional';
UPDATE plan_limits           SET plan = 'professional' WHERE plan = 'business';
UPDATE plan_limits           SET plan = 'business'     WHERE plan = 'enterprise';
UPDATE ai_default_off_undo   SET plan = 'starter'      WHERE plan = 'professional';
UPDATE ai_default_off_undo   SET plan = 'professional' WHERE plan = 'business';
UPDATE ai_default_off_undo   SET plan = 'business'     WHERE plan = 'enterprise';

-- 2. What the four plans on sale include (store.TierFeatures). Starter and no plan keep theirs.
CREATE TEMP TABLE pricing_v3_tiers (plan text, feature text, enabled boolean) ON COMMIT DROP;
INSERT INTO pricing_v3_tiers (plan, feature, enabled)
SELECT p.plan, f.feature, f.feature = ANY (p.features)
  FROM (VALUES
          ('basic',        ARRAY['cloud_recording']),
          ('professional', ARRAY['cloud_recording', 'whatsapp_crm']),
          ('business',     ARRAY['cloud_recording', 'whatsapp_crm', 'simulive', 'replay_engage', 'zoom',
                                 'ai', 'ai_knowledge', 'simulive_auto', 'followup_send', 'repurpose']),
          ('enterprise',   ARRAY['cloud_recording', 'whatsapp_crm', 'simulive', 'replay_engage', 'zoom',
                                 'ai', 'ai_knowledge', 'simulive_auto', 'followup_send', 'repurpose'])
       ) AS p (plan, features)
 CROSS JOIN unnest(ARRAY['cloud_recording', 'whatsapp_crm', 'simulive', 'replay_engage', 'zoom',
                         'ai', 'ai_knowledge', 'simulive_auto', 'followup_send', 'repurpose']) AS f (feature);

-- 3. A subscriber whose tier gave them a switch the new tier leaves out keeps it as their own
--    override, unless it was turned off for them.
UPDATE users u
   SET features = u.features || ARRAY(
         SELECT pf.feature
           FROM plan_features pf
           JOIN pricing_v3_tiers t ON t.plan = pf.plan AND t.feature = pf.feature AND NOT t.enabled
          WHERE pf.plan = effective_plan(u.id) AND pf.enabled
            AND NOT (pf.feature = ANY (u.features)) AND NOT (pf.feature = ANY (u.features_off))
          ORDER BY pf.feature)
 WHERE EXISTS (
         SELECT 1
           FROM plan_features pf
           JOIN pricing_v3_tiers t ON t.plan = pf.plan AND t.feature = pf.feature AND NOT t.enabled
          WHERE pf.plan = effective_plan(u.id) AND pf.enabled
            AND NOT (pf.feature = ANY (u.features)) AND NOT (pf.feature = ANY (u.features_off)));

-- 4. The new tiers start with what their neighbours have of every other switch (whiteboard,
--    meetings, captions); then every tier on sale gets its own switches.
INSERT INTO plan_features (plan, feature, enabled)
SELECT 'basic', feature, enabled FROM plan_features
 WHERE plan = 'professional' AND feature NOT IN (SELECT feature FROM pricing_v3_tiers)
ON CONFLICT (plan, feature) DO NOTHING;
INSERT INTO plan_features (plan, feature, enabled)
SELECT 'enterprise', feature, enabled FROM plan_features
 WHERE plan = 'business' AND feature NOT IN (SELECT feature FROM pricing_v3_tiers)
ON CONFLICT (plan, feature) DO NOTHING;
DELETE FROM plan_features pf
 USING pricing_v3_tiers t
 WHERE t.plan = pf.plan AND t.feature = pf.feature AND NOT t.enabled;
INSERT INTO plan_features (plan, feature, enabled)
SELECT plan, feature, true FROM pricing_v3_tiers WHERE enabled
ON CONFLICT (plan, feature) DO UPDATE SET enabled = true;

-- 5. Never in a tier: clips (no plan sells highlights or reels), instant sessions and HLS
--    delivery (an admin's switches for one host). Hosts an admin gave them keep them.
DELETE FROM plan_features WHERE feature IN ('clips', 'instant_webinar', 'hls_delivery');

-- 6. Recording storage for the two new tiers; the renamed ones carried theirs over.
INSERT INTO plan_limits (plan, limit_key, value) VALUES
    ('basic',      'recording_storage_bytes', 5::bigint   * 1024 * 1024 * 1024),
    ('enterprise', 'recording_storage_bytes', 500::bigint * 1024 * 1024 * 1024)
ON CONFLICT (plan, limit_key) DO NOTHING;
