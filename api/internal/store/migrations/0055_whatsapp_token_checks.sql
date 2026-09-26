-- The daily check: when Meta was last asked whether the token is still good
-- (/debug_token), so each host is checked about once a day however often Tick runs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_token_checked_at timestamptz;
-- When the "reconnect before it expires" email went out, so it is sent once per token.
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_expiry_warned_at timestamptz;
