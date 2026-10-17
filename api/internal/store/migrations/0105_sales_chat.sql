-- The sales chat on the home page: an AI answers first, a person can take over.
--
-- A conversation is owned by whoever holds its token: a visitor has no account,
-- so the browser keeps a random token and the server keeps only its SHA-256.
-- user_id is filled in when the visitor happens to be signed in, and is never what
-- grants access to the conversation.
--
-- status:
--   ai       the assistant is answering
--   waiting  a person was asked for (by the visitor, by the assistant, or because
--            no model could answer); admins have been emailed
--   human    an admin joined; the assistant stays quiet from here on
--   closed   an admin closed it
--
-- visitor_seen_at is bumped on every visitor poll. An admin's reply goes to the
-- chat when it is recent, and by email when the visitor has left — which is how
-- "admin not available right now" still ends with the visitor getting an answer.

CREATE TABLE sales_conversations (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash      text        NOT NULL UNIQUE,
    user_id         uuid        REFERENCES users (id) ON DELETE SET NULL,
    name            text        NOT NULL DEFAULT '',
    email           text        NOT NULL DEFAULT '',
    status          text        NOT NULL DEFAULT 'ai'
                                CHECK (status IN ('ai', 'waiting', 'human', 'closed')),
    handoff_reason  text        NOT NULL DEFAULT '',
    handoff_at      timestamptz,
    assigned_admin  uuid        REFERENCES users (id) ON DELETE SET NULL,
    page            text        NOT NULL DEFAULT '',
    ai_replies      int         NOT NULL DEFAULT 0,
    visitor_seen_at timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sales_conversations_inbox_idx ON sales_conversations (status, last_message_at DESC);

CREATE TABLE sales_messages (
    id              bigserial   PRIMARY KEY,
    conversation_id uuid        NOT NULL REFERENCES sales_conversations (id) ON DELETE CASCADE,
    role            text        NOT NULL CHECK (role IN ('visitor', 'ai', 'admin', 'system')),
    author_id       uuid        REFERENCES users (id) ON DELETE SET NULL,
    author_name     text        NOT NULL DEFAULT '',
    body            text        NOT NULL,
    -- An admin reply sent to the visitor's inbox because they had left the chat.
    emailed         boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sales_messages_conversation_idx ON sales_messages (conversation_id, id);

-- An admin is "available" while the sales inbox is open in their browser: the
-- inbox bumps this as it polls. The widget uses it to say whether the team is
-- online now or will reply by email.
CREATE TABLE sales_admin_presence (
    user_id uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    seen_at timestamptz NOT NULL DEFAULT now()
);

-- Two new outbox kinds: the note to admins when a person is needed, and an admin's
-- reply mailed to a visitor who left.
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
    'password_reset',
    'host_request',
    'sales_handoff',
    'sales_reply'
));
