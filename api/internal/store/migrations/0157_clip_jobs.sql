/* Clips and reels made from a session's recording (api/internal/api/clip_jobs.go), rendered
 * by the video server's mix recorder (deploy/livekit-hetzner/mixrec/clips.go). Behind the
 * per-host switch "clips"; nothing to backfill.
 *
 * clip_jobs is one video in one format: queued until the video server claims it, processing
 * while it holds the lease (renewed as it reports progress), then ready (storage_key holds
 * the MP4) or failed (error says why, in plain words). A lease that runs out puts the job
 * back in the queue, until attempts reaches the cap.
 *
 *   recording_id  the recording session (the take with no parent): a clip goes with it, by
 *                 the cascade (deleted by the host, by the retention sweep, with its webinar)
 *   segments      [{partId, playerStart, playerEnd, fileStart}], internal/clips.Segment, in
 *                 the order they play: one for a clip, 2-4 for a reel
 *   subtitles     the burned-in captions and hook title as an ASS script, made when the job
 *                 is created ('' for none)
 *   posts         [types.ClipPost], the suggested post text per platform
 *   rush_until    an admin's "Make it now": the job keeps the on-demand video server wanted
 *                 until then, so it starts to make it
 *
 * A clip's bytes count against its recording's owner's storage (recording_used_bytes). Its
 * file is not deleted by the cascade: every deleted row with a file leaves its key in
 * clip_blob_deletions, and the maintenance sweep deletes those objects. */
CREATE TABLE clip_jobs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id  uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    kind          text NOT NULL CHECK (kind IN ('clip', 'reel')),
    source_id     text NOT NULL DEFAULT '',
    title         text NOT NULL DEFAULT '',
    format        text NOT NULL CHECK (format IN ('9x16', '1x1', '16x9')),
    framing       text NOT NULL DEFAULT 'fit' CHECK (framing IN ('fit', 'center', 'left', 'right')),
    captions      boolean NOT NULL DEFAULT true,
    hook          text NOT NULL DEFAULT '',
    segments      jsonb NOT NULL,
    duration_sec  double precision NOT NULL,
    subtitles     text NOT NULL DEFAULT '',
    posts         jsonb NOT NULL DEFAULT '[]',
    post_status   text NOT NULL DEFAULT 'pending' CHECK (post_status IN ('pending', 'ready', 'failed', 'off')),
    status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
    error         text NOT NULL DEFAULT '',
    attempts      integer NOT NULL DEFAULT 0,
    progress      integer NOT NULL DEFAULT 0,
    lease_until   timestamptz,
    rush_until    timestamptz,
    storage_key   text NOT NULL UNIQUE,
    size_bytes    bigint NOT NULL DEFAULT 0,
    duration_ms   bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    started_at    timestamptz,
    finished_at   timestamptz
);
CREATE INDEX clip_jobs_recording_idx ON clip_jobs (recording_id, created_at DESC);
CREATE INDEX clip_jobs_queue_idx ON clip_jobs (created_at) WHERE status IN ('queued', 'processing');

-- Files of deleted clips, for the sweep to delete from storage.
CREATE TABLE clip_blob_deletions (
    storage_key text PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION clip_jobs_leave_blob() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('ready', 'processing') OR OLD.size_bytes > 0 THEN
        INSERT INTO clip_blob_deletions (storage_key) VALUES (OLD.storage_key)
        ON CONFLICT (storage_key) DO NOTHING;
    END IF;
    RETURN OLD;
END $$;

CREATE TRIGGER clip_jobs_leave_blob AFTER DELETE ON clip_jobs
    FOR EACH ROW EXECUTE FUNCTION clip_jobs_leave_blob();

-- Suggested reels of a recording session, as recording_highlights (0156) for highlights.
CREATE TABLE recording_reels (
    recording_id  uuid PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    reason        text NOT NULL DEFAULT '',
    body          jsonb,
    model         text NOT NULL DEFAULT '',
    claimed_until timestamptz,
    generated_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- A host's storage now counts the clips made from their recordings too.
CREATE OR REPLACE FUNCTION recording_used_bytes(uid uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
    SELECT (coalesce((SELECT sum(r.size_bytes)
                        FROM recordings r JOIN webinars w ON w.id = r.webinar_id
                       WHERE w.host_id = uid AND r.status = 'ready' AND r.size_bytes > 0), 0)
          + coalesce((SELECT sum(r.size_bytes) FROM recordings r
                       WHERE r.owner_id = uid AND r.status = 'ready' AND r.size_bytes > 0), 0)
          + coalesce((SELECT sum(c.size_bytes)
                        FROM clip_jobs c JOIN recordings r ON r.id = c.recording_id
                        LEFT JOIN webinars w ON w.id = r.webinar_id
                       WHERE coalesce(r.owner_id, w.host_id) = uid
                         AND c.status = 'ready' AND c.size_bytes > 0), 0))::bigint
$$;
