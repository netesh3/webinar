-- Any "off" of the room's AI switch during a live session keeps the whole session out of AI,
-- even if it is switched back on later (decided 2026-10-22): no recap, leads, follow-ups or
-- Q&A assistant for it. Set by the controls PATCH while live; reset when a session goes live
-- (to whether AI is off at that moment). Read through SessionControls.AIOffThisSession.
ALTER TABLE webinars ADD COLUMN ai_off_this_session boolean NOT NULL DEFAULT false;
