/* The Studio's content plan (api/internal/api/studio.go): where and when the host means to
 * post a clip or reel they made, and how far they got. Planning only: nothing is posted to
 * any network from here. Behind the per-host switch "clips"; nothing to backfill.
 *
 * One row per clip job, made the first time the host plans it, deleted with the clip (and so
 * with its recording, by the cascade):
 *   platforms   the ClipPlatform* ids it is meant for (instagram_reels, youtube_shorts, ...)
 *   planned_on  the day it is meant to go out, in the host's own calendar; null is unplanned
 *   status      idea, scheduled (a day is set) or posted
 *   note        the host's own words, for themselves */
CREATE TABLE clip_plans (
    clip_id     uuid PRIMARY KEY REFERENCES clip_jobs(id) ON DELETE CASCADE,
    platforms   text[] NOT NULL DEFAULT '{}',
    planned_on  date,
    status      text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'scheduled', 'posted')),
    note        text NOT NULL DEFAULT '',
    updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- updated_by's foreign key, for deleting an account without a scan.
CREATE INDEX clip_plans_updated_by_idx ON clip_plans (updated_by) WHERE updated_by IS NOT NULL;

-- created_by's, likewise (0157 left it unindexed).
CREATE INDEX IF NOT EXISTS clip_jobs_created_by_idx ON clip_jobs (created_by) WHERE created_by IS NOT NULL;
