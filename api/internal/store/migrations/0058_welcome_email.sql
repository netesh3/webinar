/* The welcome email: one thank-you per new account, through the same outbox as every
 * other email.
 *
 * Numbered 0058, not 0057: 0057 is taken by question_votes on fix/rejoin-restores-history,
 * which had not merged when this was written. The runner records applied files by name,
 * so the gap is harmless whichever lands first.
 *
 *   html     The outbox was plain-text only. A welcome is the one message whose job is to
 *            feel good rather than to carry a link, so it gets an HTML part as well; every
 *            existing kind keeps html = '' and is sent exactly as before.
 *
 *   welcome  Addressed by email, like a registrant invitation, not by user_id: a user_id
 *            row is an in-app host alert and would appear in the bell.
 *
 * One per address, enforced here rather than by the caller remembering. Signup and a
 * first Google sign-in both try to queue it and a retry or a race between them is a
 * no-op (Notify treats the unique violation as success). Existing accounts are never
 * back-filled: rows are only written on the account-creation paths, so nobody who
 * signed up before this migration is emailed.
 */
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS html text NOT NULL DEFAULT '';

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
    'welcome'
));

CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_welcome_per_email
    ON notifications (lower(email))
    WHERE kind = 'welcome';
