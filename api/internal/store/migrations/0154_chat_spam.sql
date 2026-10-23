-- Spam detection for a live session's chat and Q&A (api/internal/api/spam.go).
--
-- session_spam_flags is one attendee message the free rules found suspicious, or the batched
-- AI pass flagged from its sample. Only the host and co-hosts ever read it; the audience
-- never sees a flag. status:
--   pending      suspicious by the rules, waiting for the AI pass
--   clear        the AI pass (or a host's "Not spam") said it is fine
--   flagged      spam, waiting for the host team
--   auto_hidden  spam the host's "Auto-hide high-confidence spam" setting hid
--   deleted | hidden | removed | muted   what a host did about it
--   not_spam     a host said it is fine
CREATE TABLE session_spam_flags (
    webinar_id      uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    item_kind       text NOT NULL CHECK (item_kind IN ('chat', 'question')),
    item_id         text NOT NULL,
    sender_identity text NOT NULL,
    sender_name     text NOT NULL DEFAULT '',
    body            text NOT NULL DEFAULT '',
    rule_score      real NOT NULL DEFAULT 0,
    reasons         text[] NOT NULL DEFAULT '{}',
    status          text NOT NULL CHECK (status IN ('pending', 'clear', 'flagged', 'auto_hidden',
                        'deleted', 'hidden', 'removed', 'muted', 'not_spam')),
    source          text NOT NULL DEFAULT 'rules' CHECK (source IN ('rules', 'ai')),
    category        text NOT NULL DEFAULT '' CHECK (category IN ('', 'promo', 'scam', 'abuse', 'off_topic', 'other')),
    confidence      real NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, item_kind, item_id)
);

CREATE INDEX session_spam_flags_pending_idx ON session_spam_flags (webinar_id, created_at)
    WHERE status = 'pending';

-- One session's spam settings and pass state. allow_links off (the default) counts a link
-- from an attendee as a spam signal; auto_hide (off by default) hides spam flagged at 0.9 or
-- more without waiting for the host. limited_at is when a pass last stopped at an AI cap;
-- last_pass_at bounds the next pass's sample of recent chat.
CREATE TABLE session_spam_state (
    webinar_id   uuid PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
    allow_links  boolean NOT NULL DEFAULT false,
    auto_hide    boolean NOT NULL DEFAULT false,
    limited_at   timestamptz,
    last_pass_at timestamptz
);

-- "Mute chat for this person": their chat and questions are refused until a host unmutes them.
CREATE TABLE session_chat_mutes (
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, identity)
);
