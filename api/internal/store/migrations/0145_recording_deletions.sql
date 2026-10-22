-- The admin "Cost by host" report (store/admin_costs.go) prices recording storage by GB × days
-- held. A deleted recording's row is gone, and with it how long it was kept, so each delete
-- (the host's, the retention sweep's, a webinar's cascade) leaves a line here. No foreign
-- keys: the point is to outlive the recording, the webinar and the host. host_id is looked up
-- at delete time and is NULL when the webinar went first (a cascade from deleting it).
CREATE TABLE recording_deletions (
    recording_id uuid PRIMARY KEY,
    webinar_id   uuid,
    host_id      uuid,
    size_bytes   bigint NOT NULL DEFAULT 0,
    duration_ms  bigint NOT NULL DEFAULT 0,
    egress_id    text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL,
    deleted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recording_deletions_deleted ON recording_deletions (deleted_at);
-- Like every app table (0014): nothing for PostgREST.
ALTER TABLE recording_deletions ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION log_recording_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO recording_deletions (recording_id, webinar_id, host_id, size_bytes, duration_ms,
                                     egress_id, created_at)
    VALUES (OLD.id, OLD.webinar_id,
            (SELECT host_id FROM webinars WHERE id = OLD.webinar_id),
            coalesce(OLD.size_bytes, 0), coalesce(OLD.duration_ms, 0), coalesce(OLD.egress_id, ''),
            OLD.created_at)
    ON CONFLICT (recording_id) DO NOTHING;
    RETURN OLD;
END $$;

CREATE TRIGGER recordings_log_deletion AFTER DELETE ON recordings
    FOR EACH ROW EXECUTE FUNCTION log_recording_deletion();

-- The report reads sessions by when they started, and sent mail by when it went.
CREATE INDEX webinars_started_idx ON webinars (started_at) WHERE started_at IS NOT NULL;
CREATE INDEX notifications_sent_idx ON notifications (delivered_at) WHERE delivery = 'sent';
