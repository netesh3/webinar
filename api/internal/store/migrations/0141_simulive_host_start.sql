-- A simulive's host in the room before the start (api/internal/api/simulive_host.go).
--
-- 1. simulive_start_at: a start the host or a co-host set from the room — "Start in 5 min",
--    "Delay 5 min". NULL when none is pending. It replaces starts_at as the moment the
--    simulive goes live (the same guarded due-check, store/simulive_live.go), for a manual
--    simulive as for an automatic one, and is cleared when the session starts.
--
-- 2. simulive_doors_open: the host pressed "Open doors now", so the audience may come in and
--    wait before the doors would have opened by themselves (options.simuliveDoorsOpenMin).
--
-- 3. simulive_live_at: when the recording reached its end with the host team in the room and
--    the session carried on as a live Q&A with them on the stage ("live after"). NULL while
--    the recording plays. simulive_host_gone_at: in live-after, when the last of the host team
--    was seen to leave; the session ends a grace after it unless one of them is back.
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS simulive_start_at timestamptz;
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS simulive_live_at timestamptz;
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS simulive_host_gone_at timestamptz;
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS simulive_doors_open boolean NOT NULL DEFAULT false;
