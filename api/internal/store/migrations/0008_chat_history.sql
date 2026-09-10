-- Persistent chat: the transcript, and the images in it.
--
-- Chat used to exist only in flight. It travelled over the SFU's data channel and lived
-- in whatever browsers happened to be listening, which meant three things were true and
-- all three were wrong: reloading the page lost the conversation, joining late meant
-- joining a conversation already in progress with no way to read it, and once the
-- session ended nothing that was said had ever been written down.
--
-- ON THE ABSENCE OF A CACHE TIER
--
-- The obvious shape is Redis for the live session and a move to Postgres at the end.
-- This is one row per message in Postgres from the start, because on a single node the
-- cache buys nothing it costs: an indexed read of one session's tail is sub-millisecond
-- either way, while a two-tier design adds a migration step that can fail — and until
-- it runs, the transcript exists only in the volatile half. Two stores can also
-- disagree about what was said, and the archive is the copy people will later argue
-- about. Store.ChatBacklog is the seam if this ever needs to be Redis-backed for
-- horizontal scale.
CREATE TABLE chat_messages (
    -- The sender's own id, not ours.
    --
    -- Client-generated (crypto.randomUUID) and used as the primary key, which is what
    -- makes delivery idempotent: a message resent because the response was lost, or
    -- because the tab reconnected mid-send, collides and is ignored rather than
    -- appearing twice. The alternative — a server id plus a separate dedupe column —
    -- is the same rule with an extra index and a window where it does not hold.
    id         text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,

    -- The ordering, and the sync cursor.
    --
    -- A sequence rather than the timestamp, for two reasons: two messages in the same
    -- millisecond still need a total order, and a reconnecting client needs to ask for
    -- "everything after 214" — which a timestamp cannot answer without risking either a
    -- gap or a duplicate at the boundary.
    seq        bigserial NOT NULL,

    -- Who said it. The identity is the one we minted for the SFU, which is what ties a
    -- message to a participant whether or not they have an account.
    sender_identity text NOT NULL,
    sender_name     text NOT NULL,
    sender_role     text NOT NULL CHECK (sender_role IN ('host', 'panelist', 'attendee')),
    -- Set for a signed-in account, NULL for an attendee holding only a join key — which
    -- is most of an audience. SET NULL on delete: the transcript is a record of what was
    -- said, and losing a line because somebody closed their account later would be
    -- rewriting it.
    sender_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,

    message_type text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
    -- The audience the message was sent to, stored per message so that the host
    -- changing the setting never rewrites history — and so the backlog can be filtered
    -- by the same rule live delivery used. Without this, replaying history to a late
    -- joiner would hand them the panelists-only messages the SFU refused to deliver.
    destination  text NOT NULL DEFAULT 'everyone'
                 CHECK (destination IN ('everyone', 'panelists')),
    content      text NOT NULL DEFAULT '',

    -- The image, for message_type = 'image'.
    --
    -- media_key is the object-storage key, and it is deliberately NOT a URL. Keys are
    -- opaque and internal; the URL served to a client points at our own API, which
    -- checks that the caller is in this webinar before streaming the bytes. A bucket
    -- URL in the payload would be a link anybody who saw it could keep.
    media_key    text,
    media_mime   text,
    media_bytes  bigint,
    -- Kept so a client can reserve the right space before the image loads. A chat log
    -- that reflows as each thumbnail arrives is a chat log that jumps under the cursor.
    media_width  int,
    media_height int,

    created_at   timestamptz NOT NULL DEFAULT now(),

    -- A text message needs words; an image needs bytes. Enforced here because a row
    -- that satisfies neither renders as an empty bubble nobody can explain.
    CONSTRAINT chat_messages_has_content CHECK (
        (message_type = 'text'  AND length(content) > 0) OR
        (message_type = 'image' AND media_key IS NOT NULL)
    )
);

-- The backlog read: one session, ordered, from a cursor. Covers both the live sync and
-- the post-session export.
CREATE INDEX chat_messages_by_session ON chat_messages (webinar_id, seq);

-- Analytics: "who spoke, how much" per session without scanning the table.
CREATE INDEX chat_messages_by_sender ON chat_messages (webinar_id, sender_identity);
