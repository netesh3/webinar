-- Connect WhatsApp: what one host granted us through Meta Embedded Signup.
--
-- On users, next to the YouTube grant (0037), and for the same reason: the
-- ACCOUNT owns the connection, every webinar it hosts borrows it, and a host who
-- reconnects does not have to revisit every session they have scheduled.
--
-- whatsapp_access_token is a business integration system user token, and it is
-- the whole of what makes sending possible. Meta bills each conversation to the
-- WhatsApp Business Account that sent it, so this column is also what keeps a
-- host's messages on the host's own bill rather than ours. Treated like
-- youtube_refresh: it never leaves the database except toward graph.facebook.com,
-- and User.Public() does not copy it.
--
-- whatsapp_display_phone and whatsapp_verified_name are what Account settings
-- shows — "+27 82 000 0000 (Acme Coaching)" means more to a host than the ids do.
--
-- The two timestamps are nullable rather than defaulted, because for both of them
-- "no value" is a real state that a zero time would misreport:
--   * whatsapp_token_expires_at — Embedded Signup normally issues a token that
--     does not expire. NULL says exactly that, instead of inviting a refresh path
--     for something that never needs one.
--   * whatsapp_connected_at — set when a grant is stored, cleared on disconnect.

ALTER TABLE users
    ADD COLUMN whatsapp_access_token     text NOT NULL DEFAULT '',
    ADD COLUMN whatsapp_waba_id          text NOT NULL DEFAULT '',
    ADD COLUMN whatsapp_phone_number_id  text NOT NULL DEFAULT '',
    ADD COLUMN whatsapp_display_phone    text NOT NULL DEFAULT '',
    ADD COLUMN whatsapp_verified_name    text NOT NULL DEFAULT '',
    ADD COLUMN whatsapp_token_expires_at timestamptz,
    ADD COLUMN whatsapp_connected_at     timestamptz;
