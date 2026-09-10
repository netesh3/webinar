-- A host mute that the participant cannot simply undo.
--
-- Muting someone is only meaningful if it holds. Without a latch, the host mutes
-- an attendee they had allowed to speak, and that attendee clicks unmute again
-- half a second later — which is exactly the situation the button exists to end.
--
-- Stored next to the grant, so a reload is not a way around it: the latch is
-- restored into the join token the same way the grant itself is. Enforcement is at
-- the SFU (the microphone leaves their allowed source list), not in the UI, so a
-- patched client cannot talk either.
--
-- Cleared by the host allowing them to speak again, and by any fresh grant — a
-- host who brings someone back on stage means it.
ALTER TABLE webinar_stage_grants
    ADD COLUMN muted_by_host boolean NOT NULL DEFAULT false;
