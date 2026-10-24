/* The admin's one-time "Delete all recordings" (api/internal/api/recording_purge.go).
 *
 * recording_purges is the job, one row per run, and its audit record: who asked, when, how
 * far it got and what it freed. The work is done in bounded steps (an admin's request, or the
 * maintenance lane), each picking up at `phase` (and, for the bucket sweep, after `sweep_after`),
 * so a step cut off by Cloud Run's request limit loses nothing: the next one carries on.
 *
 *   phase    stopping  stop recordings in progress, cancel clip renders, abort uploads
 *            deleting  delete recordings created before started_at, their files and clips
 *            sweeping  list the bucket for recording files no row points at any more
 *            done      finished_at is set
 *   settle_until  stopped server-side recorders still upload their last file; the sweep
 *                 waits for them so that file is caught too
 *
 * At most one unfinished run at a time (the partial unique index). */
CREATE TABLE recording_purges (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    requested_email     text NOT NULL DEFAULT '',
    phase               text NOT NULL DEFAULT 'stopping'
                        CHECK (phase IN ('stopping', 'deleting', 'sweeping', 'done')),
    sweep_after         text NOT NULL DEFAULT '',
    settle_until        timestamptz,
    recordings          integer NOT NULL DEFAULT 0,
    files               integer NOT NULL DEFAULT 0,
    bytes               bigint  NOT NULL DEFAULT 0,
    uploads_aborted     integer NOT NULL DEFAULT 0,
    clips               integer NOT NULL DEFAULT 0,
    simulives_affected  integer NOT NULL DEFAULT 0,
    recordings_stopped  integer NOT NULL DEFAULT 0,
    last_error          text NOT NULL DEFAULT '',
    started_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz
);
CREATE UNIQUE INDEX recording_purges_one_running ON recording_purges ((true)) WHERE phase <> 'done';
CREATE INDEX recording_purges_requested_by_idx ON recording_purges (requested_by) WHERE requested_by IS NOT NULL;
ALTER TABLE recording_purges ENABLE ROW LEVEL SECURITY;

/* A scheduled or draft simulive whose recording the purge deleted is put back to draft with
 * this set, so the host is told why ("The recording this Simulive played was deleted") rather
 * than finding a session with nothing to play. Read only while simulive_recording_id is NULL:
 * picking another recording clears the message by itself. */
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS simulive_recording_deleted_at timestamptz;
