-- Hide a broadcast from the host's list without erasing what was already sent.
--
-- A hard delete would cascade through the outbox (notifications.broadcast_id is
-- ON DELETE CASCADE) and would clear crm_messages.broadcast_id. A message that
-- reached somebody is part of that conversation, and a webinar's metrics count
-- those rows, so the card leaving the Broadcasts tab must not take them with it.
-- deleted_at is that: the list and the sweep ignore the row, and the thread stays.
ALTER TABLE crm_broadcasts
    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
