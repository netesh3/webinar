/* Reminder times per webinar.
 *
 * The two timed reminders were fixed in their kind: reminder_24h and reminder_1h (and the
 * wa_ pair), one row of each per registration, enforced by (kind, registration_id). A host
 * can now choose up to three times per webinar (webinars.options.reminders, minutes before
 * the start), so the time moves out of the kind and onto the row:
 *
 *   kind 'reminder' / 'wa_reminder', offset_min = minutes before the start.
 *
 * One of each (kind, registration, offset). The time a row is due is starts_at - offset,
 * which is also how a reschedule moves it.
 *
 * Existing rows are converted in place, sent ones included, so a reminder that already
 * went is still recognised as sent and is not queued again.
 */
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS offset_min integer;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
DROP INDEX IF EXISTS notifications_one_per_kind_reg;
DROP INDEX IF EXISTS notifications_one_wa_per_kind_reg;

UPDATE notifications SET kind = 'reminder',    offset_min = 1440 WHERE kind = 'reminder_24h';
UPDATE notifications SET kind = 'reminder',    offset_min = 60   WHERE kind = 'reminder_1h';
UPDATE notifications SET kind = 'wa_reminder', offset_min = 1440 WHERE kind = 'wa_reminder_24h';
UPDATE notifications SET kind = 'wa_reminder', offset_min = 60   WHERE kind = 'wa_reminder_1h';

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
    'wa_replay'
));

-- Exactly the reminder rows carry an offset, and it is before the start.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reminder_offset;
ALTER TABLE notifications ADD CONSTRAINT notifications_reminder_offset CHECK (
    (kind IN ('reminder','wa_reminder')) = (offset_min IS NOT NULL)
    AND (offset_min IS NULL OR offset_min > 0)
);

CREATE UNIQUE INDEX notifications_one_per_kind_reg
    ON notifications (kind, registration_id)
    WHERE registration_id IS NOT NULL
      AND kind IN ('registration_confirmed','registration_approved','replay_ready');

CREATE UNIQUE INDEX notifications_one_wa_per_kind_reg
    ON notifications (kind, registration_id)
    WHERE registration_id IS NOT NULL
      AND kind IN ('wa_registration_confirmed','wa_replay');

-- One reminder per registration per time. Re-registering, or the host saving the webinar
-- again, re-queues without duplicating; a time removed and added back is queued afresh
-- because a removed time's unsent rows are deleted, not skipped (see ReplanReminders).
DROP INDEX IF EXISTS notifications_one_reminder_per_offset;
CREATE UNIQUE INDEX notifications_one_reminder_per_offset
    ON notifications (kind, registration_id, offset_min)
    WHERE registration_id IS NOT NULL
      AND kind IN ('reminder','wa_reminder');

/* One WhatsApp reminder template instead of two.
 *
 * A host who set both keeps the 1-hour one: templates written for "in one hour" are more
 * often time-neutral ("starts at {{when}}") than ones written for the day before. The new
 * `starts_in` merge field says "in 24 hours" / "in 30 minutes" for whichever time a
 * reminder is for.
 */
ALTER TABLE crm_reminder_templates DROP CONSTRAINT IF EXISTS crm_reminder_templates_kind_check;

INSERT INTO crm_reminder_templates (host_id, kind, name, language, params, updated_at)
SELECT host_id, 'wa_reminder', name, language, params, updated_at
  FROM crm_reminder_templates t
 WHERE kind = 'wa_reminder_1h'
ON CONFLICT (host_id, kind) DO NOTHING;

INSERT INTO crm_reminder_templates (host_id, kind, name, language, params, updated_at)
SELECT host_id, 'wa_reminder', name, language, params, updated_at
  FROM crm_reminder_templates t
 WHERE kind = 'wa_reminder_24h'
ON CONFLICT (host_id, kind) DO NOTHING;

DELETE FROM crm_reminder_templates WHERE kind IN ('wa_reminder_24h','wa_reminder_1h');

ALTER TABLE crm_reminder_templates ADD CONSTRAINT crm_reminder_templates_kind_check
    CHECK (kind IN ('wa_registration_confirmed','wa_reminder','wa_replay'));
