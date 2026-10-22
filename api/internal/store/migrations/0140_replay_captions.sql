-- Captions on replays (api/internal/captionvtt): a recording, and a simulive of it, show the
-- original session's own captions as CC instead of transcribing the video again.
--
-- 1. captions_shown_live: whether people were ever SHOWN captions while this webinar was live.
--    The transcript may also exist silently, kept only for the AI (controls.aiEnabled with
--    captions off), and a transcript the host never showed must not appear on a public replay
--    by default. Sticky: set when captions are on at go-live or switched on while live, never
--    cleared. Existing sessions are backfilled from the caption switch as it was left.
--
-- 2. replay_captions: the host's "Show captions on replays". NULL means the default, which is
--    captions_shown_live.
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS captions_shown_live boolean NOT NULL DEFAULT false;
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS replay_captions boolean;

UPDATE webinars SET captions_shown_live = true
 WHERE captions_enabled AND started_at IS NOT NULL;
