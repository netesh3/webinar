-- Who a chat message @mentions, by participant identity.
--
-- Identities rather than names, because two people in one room can share a name and
-- a tag has to reach the one the sender picked. Stored with the row so a reload, a
-- reconnect or a late joiner's backlog keeps the highlight — a mention that only
-- existed in flight would vanish on the first refresh.
--
-- Already validated when written (see filterMentions in api/internal/api/mentions.go):
-- nothing lands here that the sender was not allowed to mention, or that the person
-- mentioned could not read. The text keeps its own plain "@Name", so the export and
-- any older client read correctly without this column.
--
-- An array rather than a join table: at most ten entries, only ever read with the
-- message, never queried by on its own. Empty by default, which is what every
-- message written before this migration means.
ALTER TABLE chat_messages
    ADD COLUMN mentions text[] NOT NULL DEFAULT '{}'
        CHECK (cardinality(mentions) <= 10);
