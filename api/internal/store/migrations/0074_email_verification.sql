-- Email verification for password signups.
--
-- A new password account cannot sign in until it opens the one-time link. The raw
-- token is only in that mail. This table stores its hash, so a database read is not
-- enough to confirm somebody else's address.
--
-- Accounts that already exist were using the product before this check. Leaving them
-- unverified would lock every current host out. New signups leave the column null;
-- CreateUser does not set it.
--
-- Google sign-in is not in this table. That door marks email_verified_at itself,
-- because Google has already confirmed the address.

ALTER TABLE users
    ADD COLUMN email_verified_at timestamptz;

UPDATE users
   SET email_verified_at = now()
 WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_verification_tokens_hash_idx
    ON email_verification_tokens (token_hash);

CREATE INDEX email_verification_tokens_user_idx
    ON email_verification_tokens (user_id, created_at DESC);

-- The verification mail goes through the same outbox as every other email.
-- Resends are another row each, so this kind is not unique per address.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'approval_requested',
    'registration_approved',
    'registration_declined',
    'registration_confirmed',
    'reminder',
    'wa_registration_confirmed',
    'wa_reminder',
    'wa_broadcast',
    'wa_drip',
    'replay_ready',
    'wa_replay',
    'welcome',
    'panelist_invited',
    'panelist_rescheduled',
    'panelist_cancelled',
    'email_verify'
));
