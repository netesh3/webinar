/* The rest of WhatsApp's template shapes: authentication, limited-time offer, carousel,
 * and copy-code / phone buttons.
 *
 * crm_templates.layout is the structure Meta describes beyond header, body, footer and
 * buttons: {"offer": {...}, "cards": [...], "auth": {...}}. It is part of the cache, so
 * it is replaced on every sync like the rest of the row.
 *
 * crm_template_defaults is what the host chose for one of their templates that Meta does
 * not keep: the coupon a copy-code button sends by default, and a carousel's card
 * pictures (and the shape they were made in). Beside the cache rather than in it, for
 * the same reason as crm_template_media (0110).
 *
 * crm_broadcast_header gains one broadcast's own coupon, offer end, and card pictures.
 */
ALTER TABLE crm_templates ADD COLUMN layout jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE crm_template_defaults (
    host_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          text NOT NULL,
    language      text NOT NULL,
    coupon_code   text NOT NULL DEFAULT '',
    card_aspect   text NOT NULL DEFAULT '' CHECK (card_aspect IN ('', 'square', 'wide')),
    card_file_ids uuid[] NOT NULL DEFAULT '{}',
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, name, language)
);

ALTER TABLE crm_broadcast_header
    ADD COLUMN coupon_code text NOT NULL DEFAULT '',
    ADD COLUMN offer_expires_at timestamptz,
    ADD COLUMN card_file_ids uuid[] NOT NULL DEFAULT '{}';
