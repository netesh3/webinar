-- Live captions as an in-session control rather than a schedule-time badge.
--
-- options->>'captions' was the only record that a host wanted captions, and
-- nothing in the room ever read it: ticking "Live captions" changed a badge on
-- the registration page and nothing else. The switch that did work lived in one
-- browser's memory, so it was never persisted and never reached anyone else --
-- which is why only the host's own voice was ever transcribed and why a panelist
-- answering a question produced no captions at all.
--
-- As a control it is stored and mirrored into LiveKit room metadata, the same
-- path chat and polls use to reach five hundred browsers without polling.
ALTER TABLE webinars
    ADD COLUMN captions_enabled boolean NOT NULL DEFAULT false;

-- Honour what hosts already asked for when they scheduled.
UPDATE webinars
   SET captions_enabled = true
 WHERE coalesce((options ->> 'captions')::boolean, false);
