/* Panelist mail: the invitation with the stage link, a moved start, a cancellation.
 *
 * Addressed by email with no registration_id, like the welcome email: a panelist signs in
 * to reach the stage, so there is no join key to attach and nothing for the registration
 * filter in the outbox to check.
 *
 * One invitation per panelist per webinar, enforced here so every save of the schedule
 * form can offer the whole panel and only the people who are new are written. Notify
 * treats the unique violation as success. Removing somebody from the panel drops the row
 * (see ForgetPanelistInvites), so adding them back invites them again.
 */
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
    'panelist_cancelled'
));

CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_panelist_invite
    ON notifications (webinar_id, lower(email))
    WHERE kind = 'panelist_invited';
