-- Per-account override of the plan's stage cap (types.PlanStageCap): how many people may be
-- on one webinar's stage at once, host included. NULL uses the plan. Set by an admin only;
-- the admin screen shows what a bigger stage costs, since SFU traffic grows with its square.
ALTER TABLE users ADD COLUMN stage_cap integer
    CHECK (stage_cap IS NULL OR stage_cap BETWEEN 1 AND 25);
