/* The "Edge delivery (beta)" account switch (edge_delivery) is gone.
 *
 * It gated edge delivery on the Hetzner video server, which is sunset: production video is
 * the DigitalOcean box, where every webinar is edge for every host, and any other server now
 * offers every host the Standard / Edge choice (api/internal/api/edge.go). Its key leaves
 * types.Features, so a row still naming it would be a switch nobody can see, and the admin
 * "Plans" save refuses an unknown key (unknown_feature): a tier that still listed it could
 * not be saved again. So the key goes from every place a switch is stored: plan defaults,
 * per-account "on" overrides and per-account "off" overrides. Webinars keep their delivery. */
DELETE FROM plan_features WHERE feature = 'edge_delivery';

UPDATE users SET features = array_remove(features, 'edge_delivery')
 WHERE 'edge_delivery' = ANY (features);

UPDATE users SET features_off = array_remove(features_off, 'edge_delivery')
 WHERE 'edge_delivery' = ANY (features_off);
