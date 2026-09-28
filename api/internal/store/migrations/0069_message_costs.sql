/* What Meta charged for each outbound WhatsApp message, and which webinar it was about.
 *
 * cost_micros is the charge in millionths of the currency unit (1_000_000 = 1).
 * pricing_category is Meta's category (utility, marketing, service, …).
 * cost_estimated is true when Meta named a category but not an amount, and the
 * number came from the per-country rate table. The WhatsApp page then says "about".
 *
 * webinar_id already exists (0053) and is already indexed. This migration states
 * it again so a database that somehow skipped that column still has it, and adds
 * the (host_id, created_at) index the metrics aggregate reads.
 */
ALTER TABLE crm_messages
    ADD COLUMN IF NOT EXISTS cost_micros bigint,
    ADD COLUMN IF NOT EXISTS pricing_category text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cost_estimated boolean NOT NULL DEFAULT false;

ALTER TABLE crm_messages
    ADD COLUMN IF NOT EXISTS webinar_id uuid REFERENCES webinars(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS crm_messages_host_created_idx
    ON crm_messages (host_id, created_at);

CREATE INDEX IF NOT EXISTS crm_messages_webinar_idx
    ON crm_messages (webinar_id) WHERE webinar_id IS NOT NULL;
