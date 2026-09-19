-- One cloud recording per webinar, built from however many times the host
-- pressed Record. Each start/stop is still its own file — LiveKit Egress and
-- the browser MediaRecorder both finalise a container on stop, and those
-- cannot be appended to in place — but the extra rows hang off the first as
-- parts of the same session, so the host sees one recording rather than a
-- list of takes.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES recordings(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS recordings_parent_idx ON recordings (parent_id) WHERE parent_id IS NOT NULL;

-- Fold takes that already exist. The oldest row on a webinar becomes the
-- session; everything later is a part of it. Share URLs for the oldest id
-- keep working; later ids remain valid for a single part.
UPDATE recordings c
   SET parent_id = p.id
  FROM (
    SELECT webinar_id, (array_agg(id ORDER BY created_at ASC, id ASC))[1] AS id
      FROM recordings
     WHERE parent_id IS NULL
     GROUP BY webinar_id
    HAVING COUNT(*) > 1
  ) p
 WHERE c.webinar_id = p.webinar_id
   AND c.id <> p.id
   AND c.parent_id IS NULL;
