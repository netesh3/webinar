-- Meetings: a kind of session where everyone admitted is on the stage (no audience, no edge
-- or CDN delivery), sized by its own cap rather than the webinar stage cap.
ALTER TABLE webinars DROP CONSTRAINT IF EXISTS webinars_kind_check;
ALTER TABLE webinars ADD CONSTRAINT webinars_kind_check
    CHECK (kind IN ('live','simulive','recurring','meeting'));

-- Per-account override of types.PlanMeetingCap: how many people one meeting holds, host
-- included. NULL uses the plan. Set by an admin only. Webinars ignore it (users.stage_cap).
ALTER TABLE users ADD COLUMN meeting_cap integer
    CHECK (meeting_cap IS NULL OR meeting_cap BETWEEN 1 AND 50);
