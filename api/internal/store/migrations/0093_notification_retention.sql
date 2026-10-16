/* Retention for the email outbox.
 *
 * notifications is the one table every registrant writes several rows into, and
 * each sent email kept its full body, HTML and calendar attachment forever. The
 * text is template plus variables; once the webinar is well over nothing reads
 * it. Status, timestamps, subject and error stay, so delivery counts, dedupe and
 * the bell keep working (see store.PruneNotificationContent).
 *
 * notifications_content_idx holds only finished email rows that still carry a
 * body, so the daily sweep reads that set rather than the whole table, and the
 * index shrinks as rows are cleared.
 *
 * webinar_id and registration_id had no plain index. Deleting a webinar cascades
 * here and deleting a registration sets registration_id NULL, and both scanned
 * the whole table to do it; so did the outbox queries that filter on either. The
 * partial unique indexes lead with kind and cannot serve those lookups.
 *
 * Plain CREATE INDEX: migrations run in a transaction, and the table is small
 * enough today that the build is brief.
 */
CREATE INDEX notifications_content_idx ON notifications (created_at)
    WHERE channel = 'email' AND email <> '' AND delivery <> 'pending' AND body <> '';

CREATE INDEX notifications_webinar_idx ON notifications (webinar_id)
    WHERE webinar_id IS NOT NULL;

CREATE INDEX notifications_registration_idx ON notifications (registration_id)
    WHERE registration_id IS NOT NULL;
