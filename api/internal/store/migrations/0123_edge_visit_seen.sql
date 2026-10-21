-- When an edge viewer's browser last said it was still watching. NULL for a visit the SFU
-- webhooks own (the stage, and every viewer of a standard webinar).
--
-- An edge visit used to open when the event stream connected and close when it ended. Both
-- ends of that lie behind the CDN proxy: a viewer who closed the tab kept a stream open on the
-- server until edgeStreamLife (25 minutes), and the old stream ending then closed the visit of
-- the same person's new tab. The browser now beats every 30 seconds instead, and a visit whose
-- beats stop is closed at the last one (store.edgeVisitStale).
ALTER TABLE attendance_visits ADD COLUMN seen_at timestamptz;
