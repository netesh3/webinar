/* A third way to send the survey: automatically, a set number of minutes after the host
 * goes live. The background tick launches it (see LaunchDueSurveys); send_after_min is
 * ignored by the other two modes and kept at 0 for them. */
ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_send_at_check;
ALTER TABLE surveys
    ADD CONSTRAINT surveys_send_at_check CHECK (send_at IN ('on_end', 'manual', 'at_minute'));

ALTER TABLE surveys
    ADD COLUMN send_after_min smallint NOT NULL DEFAULT 0 CHECK (send_after_min BETWEEN 0 AND 600);

-- The tick's query: armed, timed surveys only.
CREATE INDEX surveys_due_at_minute_idx ON surveys (webinar_id)
 WHERE status = 'draft' AND send_at = 'at_minute';
