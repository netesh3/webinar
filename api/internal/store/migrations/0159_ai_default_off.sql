-- AI is off by default for every host on every plan (types.Feature.PerHost).
--
-- No plan tier includes an AI-backed switch any more: ai (AI writing, recaps, hot-lead
-- reasons, follow-up drafts, Q&A drafts, spam checks), ai_knowledge, simulive_auto,
-- followup_send, repurpose and clips. An admin turns them on per host (Admin -> Accounts ->
-- Features), and the plan matrix refuses them (handleSetPlanFeatures, 422 per_host_feature).
--
-- 0127 already took ai out of the tiers; 0142 put ai_knowledge, simulive_auto and
-- followup_send in every tier, in effect only with ai. So, in two steps:
--
--   1. A host an admin gave ai by hand (users.features) keeps everything AI they have now:
--      each AI switch their plan gave them, and not turned off for them, becomes their own
--      forced-on override. Nothing in effect changes for them.
--   2. The AI switches leave plan_features. A host who had AI only from their plan (an admin
--      who had ticked ai in a tier since 0127) loses it; the sub-switches were not in effect
--      without ai, so nobody else loses anything.
--
-- Reversible: what each step did is kept in ai_default_off_undo (a plan row removed: plan set;
-- an override added: user_id set). store.AIDefaultOffUndoSQL puts it back, with the code that
-- refuses AI in a tier reverted first.
CREATE TABLE ai_default_off_undo (
    plan    text,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    feature text NOT NULL,
    CHECK ((plan IS NULL) <> (user_id IS NULL))
);

-- store.AIDefaultOffSQL; a store test keeps the two identical.
-- 1. Hosts with ai granted by hand keep the AI switches their plan gave them.
INSERT INTO ai_default_off_undo (user_id, feature)
SELECT u.id, pf.feature
  FROM users u
  JOIN plan_features pf ON pf.plan = effective_plan(u.id) AND pf.enabled
 WHERE pf.feature IN ('ai', 'ai_knowledge', 'simulive_auto', 'followup_send', 'repurpose', 'clips')
   AND 'ai' = ANY (u.features)
   AND NOT (pf.feature = ANY (u.features))
   AND NOT (pf.feature = ANY (u.features_off));

UPDATE users u
   SET features = u.features || ARRAY(SELECT d.feature FROM ai_default_off_undo d
                                       WHERE d.user_id = u.id AND NOT (d.feature = ANY (u.features))
                                       ORDER BY d.feature)
 WHERE EXISTS (SELECT 1 FROM ai_default_off_undo d
                WHERE d.user_id = u.id AND NOT (d.feature = ANY (u.features)));

-- 2. No plan includes an AI switch.
INSERT INTO ai_default_off_undo (plan, feature)
SELECT plan, feature FROM plan_features
 WHERE enabled
   AND feature IN ('ai', 'ai_knowledge', 'simulive_auto', 'followup_send', 'repurpose', 'clips');

DELETE FROM plan_features
 WHERE feature IN ('ai', 'ai_knowledge', 'simulive_auto', 'followup_send', 'repurpose', 'clips');
