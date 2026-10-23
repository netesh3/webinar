-- How many times a pending AI recap has been put back to wait for the after-session
-- transcript (api/internal/api/recap.go). The wait itself is bounded by wait_until; this
-- caps the number of deferrals too, so no path can keep a recap "processing" for ever.
ALTER TABLE session_recaps ADD COLUMN defers integer NOT NULL DEFAULT 0;
