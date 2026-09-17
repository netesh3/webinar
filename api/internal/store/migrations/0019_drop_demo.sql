-- The "Launch a webinar" demo door is gone — no more POST /demo/launch, no
-- more throwaway accounts minted from the marketing page. Drops the columns
-- 0018 added to track it.
--
-- Existing rows are left alone, not deleted: an account or webinar that was
-- flagged is_demo simply stops being distinguishable from an ordinary one
-- going forward, the same restraint migration 0011 took with existing hosts
-- — removing a flag that granted no ongoing capability is not a reason to
-- also remove the rows it was on.
ALTER TABLE webinars
    DROP COLUMN is_demo,
    DROP COLUMN demo_expires_at;

ALTER TABLE users
    DROP COLUMN is_demo;
