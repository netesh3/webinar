-- Password reset for email+password accounts.
--
-- Until this there was no way back in for somebody who forgot their password: no
-- reset route, and nobody — a host, an admin — can read or set it for them. The
-- link in the mail is the only copy of the raw token. This table stores its hash,
-- the same as email_verification_tokens, so reading the database is not enough to
-- take over somebody's account.
--
-- password_changed_at is when the password last changed through that link. A
-- session issued before it is refused, so a reset signs out every browser that was
-- signed in with the old password — the reason to reset one is often that somebody
-- else knows it. Null means it has never been reset, and every session stands.

ALTER TABLE users
    ADD COLUMN password_changed_at timestamptz;

CREATE TABLE password_reset_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text NOT NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_reset_tokens_hash_idx
    ON password_reset_tokens (token_hash);

CREATE INDEX password_reset_tokens_user_idx
    ON password_reset_tokens (user_id, created_at DESC);

-- The reset mail goes through the same outbox as every other email. Asking again
-- writes another row, so this kind is not unique per address either.
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
    'email_verify',
    'password_reset'
));
