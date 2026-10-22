-- Per-host switches for simulive, meetings, the AI sub-features and server captions
-- (types.Features). Plan, then overrides, as migrations/0107 set out.
--
--   simulive       OFF by default: no plan includes it. An account that already has a
--                  simulive (any status, deleted ones aside) keeps it, as a forced-on
--                  override, so nobody loses a session they set up.
--   meetings       ON in every tier: meetings were open to every host before (meeting.go).
--   ai_knowledge   ON in every tier, in effect only with ai (types.EffectiveFeatures).
--   simulive_auto  ON in every tier, in effect only with ai, replay_engage and simulive.
--   followup_send  ON in every tier, in effect only with ai.
--   captions       ON in every tier: server captions were available to every host before.
--
-- One shot. An admin who turns any of these off afterwards is not switched back on.

UPDATE users u
   SET features = array_append(u.features, 'simulive')
 WHERE NOT ('simulive' = ANY (u.features))
   AND EXISTS (SELECT 1 FROM webinars w WHERE w.host_id = u.id AND w.kind = 'simulive');

INSERT INTO plan_features (plan, feature, enabled)
SELECT p, f, true
  FROM unnest(ARRAY['', 'professional', 'business', 'enterprise']) AS p
 CROSS JOIN unnest(ARRAY['meetings', 'ai_knowledge', 'simulive_auto', 'followup_send', 'captions']) AS f
ON CONFLICT (plan, feature) DO UPDATE SET enabled = true;
