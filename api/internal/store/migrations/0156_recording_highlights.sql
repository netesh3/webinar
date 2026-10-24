-- Suggested highlights of a recorded session (api/internal/api/highlights.go): the moments
-- worth cutting into short clips, found from the audience's engagement and picked by AI from
-- the transcript. Behind the per-host switch "clips" (types.FeatureClips), which no plan tier
-- includes: absent means off, so there is nothing to backfill.
--
-- One row per recording session (recordings row with no parent):
--   status         pending (being written while claimed_until is ahead), ready, failed
--   reason         why it failed, in the recap's words (ai_limit, ai_unavailable, failed)
--   body           {"highlights": [...]}, types.Highlight each; a failed rewrite keeps the
--                  previous set readable
--   claimed_until  a request writing it, or (after a failure) backing off
CREATE TABLE recording_highlights (
    recording_id  uuid PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    reason        text NOT NULL DEFAULT '',
    body          jsonb,
    model         text NOT NULL DEFAULT '',
    claimed_until timestamptz,
    generated_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
