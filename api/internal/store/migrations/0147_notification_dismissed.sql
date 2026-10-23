-- A host can close a notification for good.
--
-- The bell listed every in-app alert ever written for a host, newest first, and the only
-- action on one was marking it read. A read alert stayed in the panel for ever, so "I dealt
-- with that" had nowhere to go.
--
-- dismissed_at is a soft delete rather than a DELETE: a host alert shares this table with the
-- email outbox (0010), and its row is also the record that the host was told. The list and the
-- badge skip dismissed rows, so a dismissed alert never comes back on a refresh.
ALTER TABLE notifications ADD COLUMN dismissed_at timestamptz;

-- The panel's query: one host's live alerts, newest first.
CREATE INDEX notifications_inbox_idx
    ON notifications (user_id, created_at DESC)
 WHERE user_id IS NOT NULL AND dismissed_at IS NULL;
