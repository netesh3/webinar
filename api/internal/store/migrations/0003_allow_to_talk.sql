-- "Allow to talk": a stage grant that is a microphone and nothing else.
--
-- The common case when a host takes a live question. A full promotion to panelist
-- puts an unprepared attendee's camera and desktop one click away from the whole
-- audience, which is not what "let them ask their question" should mean.
--
-- Stored alongside the grant so it survives that attendee reconnecting — losing
-- it would silently drop them back to the audience mid-question.
ALTER TABLE webinar_stage_grants
    ADD COLUMN audio_only boolean NOT NULL DEFAULT true;
