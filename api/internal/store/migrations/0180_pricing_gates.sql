/* Pricing gates (1 Nov 2026): what each plan includes, tightened after 0179.
 *
 *   server captions  (captions, the caption agent) Business, Enterprise and the grandfathered
 *                    Starter. Basic, Professional and no plan caption on each speaker's device,
 *                    which the room already falls back to when the switch is off.
 *   cloud recording  (cloud_recording) Professional and up. Basic records on the presenter's own
 *                    computer. Starter and no plan keep what they have.
 *   storage          (recording_storage_bytes: recordings, uploaded videos and clips together)
 *                    Basic 2 GB, Professional 10 GB, Business 100 GB, Enterprise 500 GB; Starter
 *                    keeps 10 GB. Nothing is deleted for a lower limit: a host over it keeps
 *                    everything and is refused new uploads and new cloud recordings until they
 *                    are under it (store.CreateVideoUpload, api.beginRecording).
 *
 * Nobody loses a switch they have: a subscriber whose tier gave them server captions or cloud
 * recording, and who now sits on a tier without it, keeps it as their own override, unless it
 * was turned off for them. No plan (beta hosts with no subscription) loses server captions,
 * which the owner accepted; they still caption on their device.
 *
 * Not data, and so not here: WhatsApp messages need whatsapp_crm (Professional and up since
 * 0179; now checked by the sender and the settings), the meeting cap per plan
 * (types.PlanMeetingCap) and the spam filter needing ai (api.spamCheck). */

-- store.PricingGatesSQL; a store test keeps the two identical.
CREATE TEMP TABLE pricing_gates_tiers (plan text, feature text, enabled boolean) ON COMMIT DROP;
INSERT INTO pricing_gates_tiers (plan, feature, enabled) VALUES
    ('',             'captions',        false),
    ('basic',        'captions',        false),
    ('professional', 'captions',        false),
    ('business',     'captions',        true),
    ('enterprise',   'captions',        true),
    ('starter',      'captions',        true),
    ('basic',        'cloud_recording', false),
    ('professional', 'cloud_recording', true),
    ('business',     'cloud_recording', true),
    ('enterprise',   'cloud_recording', true);

-- 1. A subscriber keeps what their tier gave them and their new tier does not, as an override.
UPDATE users u
   SET features = u.features || ARRAY(
         SELECT pf.feature
           FROM plan_features pf
           JOIN pricing_gates_tiers t ON t.plan = pf.plan AND t.feature = pf.feature AND NOT t.enabled
          WHERE pf.plan = effective_plan(u.id) AND pf.plan <> '' AND pf.enabled
            AND NOT (pf.feature = ANY (u.features)) AND NOT (pf.feature = ANY (u.features_off))
          ORDER BY pf.feature)
 WHERE EXISTS (
         SELECT 1
           FROM plan_features pf
           JOIN pricing_gates_tiers t ON t.plan = pf.plan AND t.feature = pf.feature AND NOT t.enabled
          WHERE pf.plan = effective_plan(u.id) AND pf.plan <> '' AND pf.enabled
            AND NOT (pf.feature = ANY (u.features)) AND NOT (pf.feature = ANY (u.features_off)));

-- 2. The tiers.
DELETE FROM plan_features pf
 USING pricing_gates_tiers t
 WHERE t.plan = pf.plan AND t.feature = pf.feature AND NOT t.enabled;
INSERT INTO plan_features (plan, feature, enabled)
SELECT plan, feature, true FROM pricing_gates_tiers WHERE enabled
ON CONFLICT (plan, feature) DO UPDATE SET enabled = true;

-- 3. Storage per plan. Starter and no plan are left as they are.
INSERT INTO plan_limits (plan, limit_key, value) VALUES
    ('basic',        'recording_storage_bytes', 2::bigint   * 1024 * 1024 * 1024),
    ('professional', 'recording_storage_bytes', 10::bigint  * 1024 * 1024 * 1024),
    ('business',     'recording_storage_bytes', 100::bigint * 1024 * 1024 * 1024),
    ('enterprise',   'recording_storage_bytes', 500::bigint * 1024 * 1024 * 1024)
ON CONFLICT (plan, limit_key) DO UPDATE SET value = EXCLUDED.value;
