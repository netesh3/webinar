-- The host's choice of composite layout (SessionControls.audienceLayout): how edge viewers,
-- CDN viewers and recordings see the stage. Validated by the API rather than a CHECK so a new
-- layout is a code change, not a migration; an unknown stored value reads as 'auto'.
ALTER TABLE webinars ADD COLUMN audience_layout text NOT NULL DEFAULT 'auto';
