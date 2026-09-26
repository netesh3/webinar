-- When Meta last refused this host's stored WhatsApp token (Graph error 190).
--
-- The connection row still looks connected — the token is there — but nothing sent
-- with it will work. Recording the refusal is what lets Account settings say so and
-- offer Reconnect, instead of every screen repeating "reconnect" with no button.
-- Cleared by SetUserWhatsApp, i.e. by connecting again or disconnecting.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_token_rejected_at timestamptz;
