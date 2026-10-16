/* The inbox holds real conversations only.
 *
 * Every automated email (confirmations, reminders, approvals, panelist mail) used
 * to be copied here after sending, tagged message_id 'outbox:<notification id>'.
 * The outbox row in notifications stays the record of what was sent; the copies
 * are dropped.
 *
 * created_at is indexed on its own for the retention sweep, which deletes across
 * every host (see store.PruneHostEmails).
 */
DELETE FROM host_emails WHERE message_id LIKE 'outbox:%';

CREATE INDEX host_emails_created ON host_emails (created_at);
