-- Stopping a stream used to clear stream_ingest, which is the only copy of the
-- host's stream key — so "Stop streaming" then "Go live" asked them to paste it
-- again. Whether we are pushing is a separate question from whether a
-- destination is saved, so it gets its own column.
--
-- stream_ingest now outlives a stop; stream_on is what the encoder follows.

ALTER TABLE webinars
    ADD COLUMN stream_on boolean NOT NULL DEFAULT false;

UPDATE webinars SET stream_on = true WHERE stream_ingest <> '';
