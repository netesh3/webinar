-- Add max_duration_min to users (custom limit per user configured by admins; NULL uses system default).
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_duration_min integer DEFAULT NULL CHECK (max_duration_min IS NULL OR max_duration_min > 0);

-- Add max_duration_min to webinars (frozen at creation from host limit or system default, default 180 min = 3 hours).
ALTER TABLE webinars ADD COLUMN IF NOT EXISTS max_duration_min integer NOT NULL DEFAULT 180 CHECK (max_duration_min > 0);
