/* Three switches of their own (2 Nov 2026), each until now on for every host, ungated:
 *
 *   stream_out   Professional and up: streaming out to YouTube or RTMP.
 *   google_drive Business and up: playing a Google Drive video into a session.
 *   csv_export   Professional and up: every host-facing file export (registrants, attendance,
 *                engagement, the session report, the transcript, the chat).
 *
 * Streaming out: sending a session live to YouTube, LinkedIn, Facebook or
 * Instagram, or any RTMP address, is a switch of its own, stream_out, sold from Professional
 * up. Until now every host had it, ungated.
 *
 * In the Professional, Business and Enterprise tiers, and in the grandfathered Starter, which
 * had it. A Basic subscriber who has used it keeps it as their own override, unless it was
 * turned off for them: one with YouTube connected, a LinkedIn, Facebook or Instagram key saved,
 * or a webinar set to stream. Hosts with no plan lose it, as they lost server captions (0180)
 * and audience insights (0181). The API refuses streaming without it at every point that starts
 * one (api.requireStreamOut, mixPlan, applyYouTubeLive).
 *
 * Google Drive and CSV exports leave no record of use (the Drive picker runs in the browser,
 * and exports are not logged), so every existing subscriber of a plan that loses one keeps it
 * as an override: Basic and Professional keep google_drive, Basic keeps csv_export. Starter
 * keeps both in its tier. Hosts with no plan lose both. The account's own deletion is not an
 * export and is not gated. */

-- store.StreamOutSQL; a store test keeps the two identical.
INSERT INTO plan_features (plan, feature, enabled) VALUES
    ('professional', 'stream_out', true),
    ('business',     'stream_out', true),
    ('enterprise',   'stream_out', true),
    ('starter',      'stream_out', true)
ON CONFLICT (plan, feature) DO UPDATE SET enabled = true;
UPDATE users u
   SET features = u.features || ARRAY['stream_out']
 WHERE effective_plan(u.id) = 'basic'
   AND NOT ('stream_out' = ANY (u.features))
   AND NOT ('stream_out' = ANY (u.features_off))
   AND (u.youtube_refresh <> ''
        OR u.linkedin_ingest <> '' OR u.facebook_ingest <> '' OR u.instagram_ingest <> ''
        OR EXISTS (SELECT 1 FROM webinars w
                    WHERE w.host_id = u.id
                      AND (w.stream_ingest <> '' OR (w.options ->> 'multistream')::boolean IS TRUE)));
INSERT INTO plan_features (plan, feature, enabled) VALUES
    ('business',     'google_drive', true),
    ('enterprise',   'google_drive', true),
    ('starter',      'google_drive', true),
    ('professional', 'csv_export',   true),
    ('business',     'csv_export',   true),
    ('enterprise',   'csv_export',   true),
    ('starter',      'csv_export',   true)
ON CONFLICT (plan, feature) DO UPDATE SET enabled = true;
UPDATE users u
   SET features = u.features || ARRAY['google_drive']
 WHERE effective_plan(u.id) IN ('basic', 'professional')
   AND NOT ('google_drive' = ANY (u.features))
   AND NOT ('google_drive' = ANY (u.features_off));
UPDATE users u
   SET features = u.features || ARRAY['csv_export']
 WHERE effective_plan(u.id) = 'basic'
   AND NOT ('csv_export' = ANY (u.features))
   AND NOT ('csv_export' = ANY (u.features_off));
