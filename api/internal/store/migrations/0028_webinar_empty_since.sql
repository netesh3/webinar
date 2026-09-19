-- When a live webinar was first observed with nobody in the room.
--
-- The empty-room sweeper needs emptiness measured over minutes, not at the
-- instant it polls: one empty reading is also what a mass reconnect looks like.
-- The clock lives here rather than in the API process because Cloud Run
-- replaces instances often enough that in-memory state would keep restarting.
-- NULL means "somebody is in there", which is also the state every existing row
-- starts in.
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS empty_since timestamptz;
