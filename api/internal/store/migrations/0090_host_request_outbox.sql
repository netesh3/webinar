-- A hosting request used to send its email inside the HTTP handler. Gmail
-- then held the response until the request deadline. The note now waits in
-- the same outbox as every other mail, and the sweep retries it.
--
-- reply_to is set on that note so the review inbox can answer the person.
-- Every other kind leaves it empty and still takes Reply-To from the host
-- inbox when there is one.

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS reply_to text NOT NULL DEFAULT '';

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
    'panelist_cancelled',
    'email_verify',
    'password_reset',
    'host_request'
));
