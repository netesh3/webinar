-- Migration 0025: Recording S3 sync tracking and processing status.

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS uploaded_to_s3 boolean NOT NULL DEFAULT false;

-- Allow 'processing' status in check constraint
ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_status_check;
ALTER TABLE recordings ADD CONSTRAINT recordings_status_check 
    CHECK (status IN ('recording', 'processing', 'ready', 'failed'));

-- Existing ready recordings are marked as uploaded to s3
UPDATE recordings SET uploaded_to_s3 = true WHERE status = 'ready';
