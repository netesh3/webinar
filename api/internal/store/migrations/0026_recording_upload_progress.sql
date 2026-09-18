-- Migration 0026: Recording upload percentage tracking.

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS upload_percent integer NOT NULL DEFAULT 0;

-- Existing ready recordings are at 100%
UPDATE recordings SET upload_percent = 100 WHERE status = 'ready' OR uploaded_to_s3 = true;
