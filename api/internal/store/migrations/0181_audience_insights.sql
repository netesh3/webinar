/* Audience insights (1 Nov 2026): a webinar's audience by device (phone, laptop or tablet, and
 * the browser) and by location (country, region, city) is a switch of its own,
 * audience_insights, sold from Professional up. Until now every host had it, ungated.
 *
 * In the Professional, Business and Enterprise tiers, and in the grandfathered Starter, which
 * had it. A Basic subscriber who has it today keeps it as their own override, unless it was
 * turned off for them: nobody on a plan loses it. Hosts with no plan lose it, as they lost
 * server captions in 0180. The API refuses the two breakdowns without it
 * (api.handleWebinarDevices, handleWebinarLocations); no CSV export carries them. */

-- store.AudienceInsightsSQL; a store test keeps the two identical.
INSERT INTO plan_features (plan, feature, enabled) VALUES
    ('professional', 'audience_insights', true),
    ('business',     'audience_insights', true),
    ('enterprise',   'audience_insights', true),
    ('starter',      'audience_insights', true)
ON CONFLICT (plan, feature) DO UPDATE SET enabled = true;
UPDATE users u
   SET features = u.features || ARRAY['audience_insights']
 WHERE effective_plan(u.id) = 'basic'
   AND NOT ('audience_insights' = ANY (u.features))
   AND NOT ('audience_insights' = ANY (u.features_off));
