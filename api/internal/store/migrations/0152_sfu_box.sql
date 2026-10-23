-- The on-demand video server (api/internal/api/sfu_box.go, deploy/digitalocean/README.md).
--
-- sfu_box_state is one row per LiveKit project whose droplet the API creates and deletes:
-- what it should be (desired), what it is (actual), the droplet, and the bookkeeping the
-- one-minute tick needs to act on it at most once at a time:
--
--   actual          down → creating → booting → ready → draining → deleting → down;
--                   failed is down after too many attempts (still retried, with backoff).
--   lease_holder /  a step takes the row for a short while, so two ticks (or a tick and a
--   lease_until     join) never both create a droplet. The conditional UPDATE is the lock.
--   last_needed_at  the last moment something needed the box: the idle grace counts from it.
--   requested_until a join, Start or instant session asked for the box, and keeps it wanted
--                   until then (the waiting screen asks again every few seconds).
--   failures /      consecutive create or boot failures, and when the next attempt may go.
--   next_attempt_at
--   alerted_at      the last admin alert for this outage (one per incident).
--
-- sfu_box_runs is one row per droplet, created to deleted: the box's billed hours for the
-- admin cost report (instead of assuming 24/7).
CREATE TABLE sfu_box_state (
    project         text PRIMARY KEY CHECK (project <> ''),
    desired         text NOT NULL DEFAULT 'down' CHECK (desired IN ('up', 'down')),
    actual          text NOT NULL DEFAULT 'down'
                    CHECK (actual IN ('down', 'creating', 'booting', 'ready', 'draining', 'deleting', 'failed')),
    droplet_id      bigint,
    since           timestamptz NOT NULL DEFAULT now(),
    last_error      text NOT NULL DEFAULT '',
    failures        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    last_needed_at  timestamptz,
    requested_until timestamptz,
    alerted_at      timestamptz,
    lease_holder    text NOT NULL DEFAULT '',
    lease_until     timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sfu_box_runs (
    id          bigserial PRIMARY KEY,
    project     text NOT NULL,
    droplet_id  bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    ready_at    timestamptz,
    deleted_at  timestamptz,
    UNIQUE (project, droplet_id)
);
CREATE INDEX sfu_box_runs_span ON sfu_box_runs (project, created_at);

ALTER TABLE sfu_box_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sfu_box_runs ENABLE ROW LEVEL SECURITY;

-- ops_alert: an operator alert in an admin's bell (the box failing to start).
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
    'recording_expiring',
    'ops_alert'
));

-- Instant sessions become an admin switch for everybody (instant_webinar now also gates
-- instant meetings): the on-demand box needs a few minutes' warning, so "go live now" is for
-- testing. Plans no longer include it; accounts an admin switched on keep it.
DELETE FROM plan_features WHERE feature = 'instant_webinar';
