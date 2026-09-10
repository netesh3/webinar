-- Recordings.
--
-- The row is the record of the recording; the bytes live in object storage behind
-- an interface (local disk now, S3 later). Keeping the metadata here rather than
-- inferring it from a directory listing is what makes "who recorded this, when,
-- how long, is it finished" answerable without touching the storage backend.
CREATE TABLE recordings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id    uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    -- Kept if the account is later deleted: the recording is still evidence of
    -- what happened, and a NULL author is better than losing the file.
    started_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    started_by_name text NOT NULL DEFAULT '',
    -- recording → the bytes are still arriving
    -- ready     → finished and playable
    -- failed    → abandoned or interrupted; the partial file is kept for triage
    status        text NOT NULL DEFAULT 'recording'
                  CHECK (status IN ('recording', 'ready', 'failed')),
    -- The container the browser actually produced. Safari records MP4 and Chrome
    -- records WebM, so this cannot be assumed — it is stored and echoed back on
    -- download, or the file arrives with a Content-Type that does not match it.
    mime          text NOT NULL,
    storage_key   text NOT NULL,
    size_bytes    bigint NOT NULL DEFAULT 0,
    duration_ms   bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    -- Last time bytes arrived. A recorder whose tab was closed stops updating
    -- this, which is how an abandoned recording is told apart from a live one
    -- without a background job.
    last_chunk_at timestamptz NOT NULL DEFAULT now(),
    stopped_at    timestamptz
);

CREATE INDEX recordings_webinar_idx ON recordings (webinar_id, created_at DESC);

-- One recording at a time per webinar, enforced by the database rather than by a
-- check-then-insert in the handler. Two panelists pressing record at the same
-- moment is a race that a SELECT cannot win.
CREATE UNIQUE INDEX recordings_one_active_idx ON recordings (webinar_id)
    WHERE status = 'recording';
