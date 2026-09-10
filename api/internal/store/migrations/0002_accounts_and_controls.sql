-- Accounts for everyone, and the live controls a host flips during a session.
--
-- Two changes worth understanding:
--
-- 1. Attendees may now hold an account. The join key stays — it is still the
--    credential for someone who registered from an email link without signing
--    up — but a registration made while signed in is linked to the account, so
--    it follows the person to a new browser instead of living in localStorage.
--
-- 2. The host's in-session controls (mute all, hide attendees, lock) are stored
--    on the webinar rather than held in a server's memory. A control has to
--    survive an API restart and apply to someone who joins ten minutes later:
--    "attendees are hidden" is a property of the session, not of a socket.

-- ------------------------------------------------------------------- accounts

ALTER TABLE users
    -- Hosting is a capability, not an account type: the same person registers
    -- for other people's webinars and runs their own. Checked server-side on
    -- every write to /api/host, so a client cannot promote itself.
    ADD COLUMN can_host      boolean NOT NULL DEFAULT false,
    ADD COLUMN last_login_at timestamptz;

-- Seeded and invited users are hosts; self-signup decides per account.
UPDATE users SET can_host = true WHERE password_hash IS NOT NULL;

-- ------------------------------------------------------- registration ↔ account

ALTER TABLE registrations
    -- ON DELETE SET NULL, not CASCADE: deleting an account must not silently
    -- drop the host's attendance records for a webinar that already happened.
    ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX registrations_user_idx ON registrations (user_id, created_at DESC);

-- ------------------------------------------------------------- live controls

ALTER TABLE webinars
    -- The Zoom-webinar default: attendees cannot see each other. Enforced at
    -- the SFU by minting attendee tokens with hidden=true, so it is not a
    -- client-side filter that a patched bundle could switch off.
    ADD COLUMN hide_attendees     boolean NOT NULL DEFAULT true,
    -- Panelists arrive muted; the host decides whether they may unmute.
    ADD COLUMN mute_on_entry      boolean NOT NULL DEFAULT true,
    ADD COLUMN allow_unmute       boolean NOT NULL DEFAULT true,
    ADD COLUMN chat_enabled       boolean NOT NULL DEFAULT true,
    ADD COLUMN qa_enabled         boolean NOT NULL DEFAULT true,
    ADD COLUMN raise_hand_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN reactions_enabled  boolean NOT NULL DEFAULT true,
    -- Locked stops new attendees joining mid-session without ending anything.
    ADD COLUMN locked             boolean NOT NULL DEFAULT false,
    ADD COLUMN started_at         timestamptz,
    ADD COLUMN ended_at           timestamptz;

-- A host asking "who is on my stage right now" is answered from the SFU, but
-- "who was promoted" has to outlive a reconnect, so stage grants are stored.
CREATE TABLE webinar_stage_grants (
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    -- The LiveKit participant identity, which for an attendee is derived from
    -- their join key. Not a users.id: promoted attendees may have no account.
    identity    text NOT NULL,
    display     text NOT NULL DEFAULT '',
    granted_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, identity)
);
