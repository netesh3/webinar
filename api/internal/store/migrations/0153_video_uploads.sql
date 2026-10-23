/* Uploaded videos: a host's own file, to play as a Simulive (api/internal/api/video_upload.go).
 *
 * An upload is a recordings row with no webinar: source 'upload', owner_id the host, title
 * what the host calls it. Everything that reads a recording through its webinar's host now
 * reads coalesce(owner_id, the webinar's host), so the storage meter, the expiry (the host's
 * retention days from when the upload finished, then "Keep longer" + 3 months, repeatable),
 * the reminders, the sweep and the cost report treat it like any other recording. A session
 * recording keeps owner_id NULL: its owner is its webinar's host, whoever that is now.
 *
 * The bytes go straight from the browser to the bucket in a multipart upload; video_uploads
 * is one such upload in flight. Its declared size is held against the quota from the start,
 * so two uploads at once cannot both fit in the space for one. The recordings row is written
 * only once the file is complete and probed, so nothing half-uploaded is ever listed.
 */

ALTER TABLE recordings
    ALTER COLUMN webinar_id DROP NOT NULL,
    ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
    ADD COLUMN source text NOT NULL DEFAULT 'session' CHECK (source IN ('session', 'upload')),
    ADD COLUMN title text NOT NULL DEFAULT '',
    -- A session recording belongs to a webinar; an upload to a host and no webinar.
    ADD CONSTRAINT recordings_belongs CHECK (
        (source = 'session' AND webinar_id IS NOT NULL) OR
        (source = 'upload' AND webinar_id IS NULL AND owner_id IS NOT NULL));

CREATE INDEX recordings_owner_idx ON recordings (owner_id, created_at DESC) WHERE owner_id IS NOT NULL;

CREATE TABLE video_uploads (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_key text NOT NULL UNIQUE,
    upload_id   text NOT NULL,
    filename    text NOT NULL,
    title       text NOT NULL,
    mime        text NOT NULL,
    size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
    part_size   bigint NOT NULL CHECK (part_size > 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_uploads_owner_idx ON video_uploads (owner_id);
CREATE INDEX video_uploads_created_idx ON video_uploads (created_at);
ALTER TABLE video_uploads ENABLE ROW LEVEL SECURITY;

-- The host a recording counts against: an upload's owner, else its webinar's host.
CREATE FUNCTION recording_host(rid uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT coalesce(r.owner_id, w.host_id)
      FROM recordings r LEFT JOIN webinars w ON w.id = r.webinar_id
     WHERE r.id = rid
$$;

CREATE OR REPLACE FUNCTION recording_used_bytes(uid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT (coalesce((SELECT sum(r.size_bytes)
                        FROM recordings r JOIN webinars w ON w.id = r.webinar_id
                       WHERE w.host_id = uid AND r.status = 'ready' AND r.size_bytes > 0), 0)
          + coalesce((SELECT sum(r.size_bytes) FROM recordings r
                       WHERE r.owner_id = uid AND r.status = 'ready' AND r.size_bytes > 0), 0))::bigint
$$;

-- Bytes of uploads still arriving: held against the quota until they finish or are abandoned.
CREATE FUNCTION video_upload_pending_bytes(uid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(size_bytes), 0)::bigint FROM video_uploads WHERE owner_id = uid
$$;

CREATE OR REPLACE FUNCTION recording_expires_at_default(rid uuid, default_days integer) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN default_days <= 0 THEN NULL ELSE
             coalesce((SELECT max(c.stopped_at) FROM recordings c
                        WHERE c.id = r.id OR c.parent_id = r.id), r.created_at)
               + make_interval(days => coalesce(u.recording_retention_days, default_days))
           END
      FROM recordings r
      LEFT JOIN webinars w ON w.id = r.webinar_id
      LEFT JOIN users u ON u.id = coalesce(r.owner_id, w.host_id)
     WHERE r.id = rid
$$;

CREATE OR REPLACE FUNCTION log_recording_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO recording_deletions (recording_id, webinar_id, host_id, size_bytes, duration_ms,
                                     egress_id, created_at)
    VALUES (OLD.id, OLD.webinar_id,
            coalesce(OLD.owner_id, (SELECT host_id FROM webinars WHERE id = OLD.webinar_id)),
            coalesce(OLD.size_bytes, 0), coalesce(OLD.duration_ms, 0), coalesce(OLD.egress_id, ''),
            OLD.created_at)
    ON CONFLICT (recording_id) DO NOTHING;
    RETURN OLD;
END $$;
