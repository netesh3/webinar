-- When the host opened a WhatsApp conversation.
--
-- status = 'read' is Meta's receipt for an outbound message (the contact read it).
-- host_read_at is the other direction: the host has opened this inbound message in
-- the app. Null means it still counts toward the unread badge. A message that
-- arrives after they open the thread is a new row, so it is unread again.
--
-- Rows that already exist are backfilled so the badge on deploy matches the
-- conversations that still need a reply. Answered and marked-done threads start
-- read. A snoozed thread stays unread, so the badge returns when the snooze ends.

ALTER TABLE crm_messages
    ADD COLUMN host_read_at timestamptz;

CREATE INDEX crm_messages_host_unread_idx
    ON crm_messages (contact_id, created_at DESC)
    WHERE direction = 'in' AND host_read_at IS NULL;

UPDATE crm_messages m
   SET host_read_at = m.created_at
 WHERE m.direction = 'in'
   AND m.host_read_at IS NULL
   AND NOT EXISTS (
        SELECT 1
          FROM crm_contacts c
         WHERE c.id = m.contact_id
           AND m.created_at = (
                SELECT max(inb.created_at) FROM crm_messages inb
                 WHERE inb.contact_id = c.id AND inb.direction = 'in')
           AND m.created_at > COALESCE((
                SELECT max(o.created_at) FROM crm_messages o
                 WHERE o.contact_id = c.id AND o.direction = 'out' AND o.manual),
                '-infinity'::timestamptz)
           AND m.created_at > COALESCE(c.inbox_done_at, '-infinity'::timestamptz)
   );
