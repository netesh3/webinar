-- The on-demand captions droplet (api/internal/api/captions_box.go, deploy/digitalocean/README.md
-- "Captions box"): one per video box, keyed by the video box's project, so a second video box
-- gets a captions box of its own. Written only by the video box's step, while it holds that
-- project's sfu_box_state lease (every UPDATE checks it), so it shares the one-step-at-a-time
-- guarantee and never needs a lease of its own.
--
--   actual          down → creating → ready → deleting → down. No "failed": a create that keeps
--                   failing stays down with failures counted and next_attempt_at backing off; the
--                   video box never waits on this row.
--   droplet_id      the droplet being created or running (the manager also lists by its tag, so
--                   a create whose answer was lost is adopted or deleted, never orphaned).
--   alerted_at      the one ops email for a run of failures; cleared when a droplet comes up.
CREATE TABLE captions_box_state (
    project         text PRIMARY KEY REFERENCES sfu_box_state (project) ON DELETE CASCADE,
    actual          text NOT NULL DEFAULT 'down' CHECK (actual IN ('down', 'creating', 'ready', 'deleting')),
    droplet_id      bigint,
    since           timestamptz NOT NULL DEFAULT now(),
    last_error      text NOT NULL DEFAULT '',
    failures        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    alerted_at      timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE captions_box_state ENABLE ROW LEVEL SECURITY;
