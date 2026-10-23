/* Recording retention a host can stretch, and the storage it is measured against.
 *
 * Expiry. A recording session (the root row and the takes folded under it) is kept for the
 * host's retention days — users.recording_retention_days, or the deployment's
 * RECORDINGS_RETENTION_DAYS (30) when that is null — counted from when its last take
 * stopped. "Keep longer" moves recordings.keep_until to the expiry in effect + 3 months, and
 * can be pressed again. The expiry in effect is the later of the two, so keep_until never
 * shortens anything: recording_expires_at below is the one definition, used by the list, the
 * sweep, the reminders and the cost report alike.
 *
 * Quota. Bytes of ready recordings across a host's webinars, extended or not, against
 * users.recording_quota_bytes (an admin's override) or the plan's plan_limits row. A trial
 * gets the Professional number whatever tier it is a trial of.
 *
 * Reminders. One row per recording, per expiry, per stage (7 days, 1 day), written in the
 * same transaction as the email and bell they announce: a second sweep finds the row and
 * sends nothing, and keeping a recording longer gives it a new expiry and so new reminders.
 */

ALTER TABLE recordings
    ADD COLUMN keep_until timestamptz,
    -- Started while the host was already over quota: default retention only, never extended.
    ADD COLUMN over_quota boolean NOT NULL DEFAULT false,
    -- "Let it expire": no more reminders for this recording.
    ADD COLUMN reminders_off boolean NOT NULL DEFAULT false;

ALTER TABLE users
    ADD COLUMN recording_quota_bytes bigint CHECK (recording_quota_bytes IS NULL OR recording_quota_bytes > 0),
    ADD COLUMN recording_retention_days integer
        CHECK (recording_retention_days IS NULL OR recording_retention_days BETWEEN 1 AND 3650);

/* Numbers a plan allows, beside plan_features' switches. One row per plan per limit, so a
 * new limit is an INSERT rather than a column, and changing what a tier gets is an UPDATE. */
CREATE TABLE plan_limits (
    plan      text NOT NULL CHECK (plan IN ('', 'professional', 'business', 'enterprise')),
    limit_key text NOT NULL,
    value     bigint NOT NULL CHECK (value >= 0),
    PRIMARY KEY (plan, limit_key)
);
ALTER TABLE plan_limits ENABLE ROW LEVEL SECURITY;

INSERT INTO plan_limits (plan, limit_key, value) VALUES
    ('',             'recording_storage_bytes', 2::bigint   * 1024 * 1024 * 1024),
    ('professional', 'recording_storage_bytes', 10::bigint  * 1024 * 1024 * 1024),
    ('business',     'recording_storage_bytes', 50::bigint  * 1024 * 1024 * 1024),
    ('enterprise',   'recording_storage_bytes', 200::bigint * 1024 * 1024 * 1024);

-- The plan whose limits apply: a trial counts as Professional.
CREATE FUNCTION limits_plan(uid uuid) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT CASE
             WHEN effective_plan(uid) <> ''
              AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = uid AND s.status = 'trialing')
             THEN 'professional'
             ELSE effective_plan(uid)
           END
$$;

CREATE FUNCTION plan_recording_quota_bytes(uid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT l.value FROM plan_limits l
                      WHERE l.plan = limits_plan(uid) AND l.limit_key = 'recording_storage_bytes'),
                    (SELECT l.value FROM plan_limits l
                      WHERE l.plan = '' AND l.limit_key = 'recording_storage_bytes'),
                    0)
$$;

CREATE FUNCTION recording_quota_bytes(uid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT u.recording_quota_bytes FROM users u WHERE u.id = uid),
                    plan_recording_quota_bytes(uid))
$$;

CREATE FUNCTION recording_used_bytes(uid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(r.size_bytes), 0)::bigint
      FROM recordings r JOIN webinars w ON w.id = r.webinar_id
     WHERE w.host_id = uid AND r.status = 'ready' AND r.size_bytes > 0
$$;

/* When the session rooted at rid would be deleted without "Keep longer": the host's retention
 * days after its last take stopped. default_days is RECORDINGS_RETENTION_DAYS; 0 or less
 * means this deployment deletes nothing, and the answer is null. */
CREATE FUNCTION recording_expires_at_default(rid uuid, default_days integer) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN default_days <= 0 THEN NULL ELSE
             coalesce((SELECT max(c.stopped_at) FROM recordings c
                        WHERE c.id = r.id OR c.parent_id = r.id), r.created_at)
               + make_interval(days => coalesce(u.recording_retention_days, default_days))
           END
      FROM recordings r
      JOIN webinars w ON w.id = r.webinar_id
      LEFT JOIN users u ON u.id = w.host_id
     WHERE r.id = rid
$$;

-- When it is deleted: the later of that and keep_until.
CREATE FUNCTION recording_expires_at(rid uuid, default_days integer) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN default_days <= 0 THEN NULL ELSE
             GREATEST(recording_expires_at_default(rid, default_days), r.keep_until)
           END
      FROM recordings r
     WHERE r.id = rid
$$;

CREATE TABLE recording_expiry_reminders (
    recording_id uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    expires_at   timestamptz NOT NULL,
    stage        text NOT NULL CHECK (stage IN ('7d', '1d')),
    sent_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (recording_id, expires_at, stage)
);
ALTER TABLE recording_expiry_reminders ENABLE ROW LEVEL SECURITY;

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
    'host_request',
    'sales_handoff',
    'sales_reply',
    'session_recap',
    'recording_expiring'
));
