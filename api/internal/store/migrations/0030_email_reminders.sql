-- Confirmation and timed reminder emails ride the existing notifications outbox.
-- due_at is when the row may be sent (now for confirmation; starts_at minus 24h/1h
-- for reminders). attempts lets the sweeper retry a failed SMTP send without
-- treating "no mail server" (skipped) as an error.

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS due_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS ics text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'approval_requested',
    'registration_approved',
    'registration_declined',
    'registration_confirmed',
    'reminder_24h',
    'reminder_1h'
));

-- One confirmation / one of each reminder per registration. Re-registering
-- (idempotent) must not enqueue a second invitation.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_kind_reg
    ON notifications (kind, registration_id)
    WHERE registration_id IS NOT NULL
      AND kind IN (
          'registration_confirmed',
          'registration_approved',
          'reminder_24h',
          'reminder_1h'
      );

CREATE INDEX IF NOT EXISTS notifications_due_idx
    ON notifications (due_at)
    WHERE delivery = 'pending' AND email <> '';
