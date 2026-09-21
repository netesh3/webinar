-- A host's own RTMP destination (YouTube, LinkedIn, …) and the public watch
-- URL that belongs with it.
--
-- The ingest URL includes the stream key, so it is never selected by the
-- ordinary webinar read — only stream_watch and "is anything set" reach the
-- JSON. The recordings tab needs the watch URL after the session; the key
-- is only for the encoder.

ALTER TABLE webinars
    ADD COLUMN stream_ingest text NOT NULL DEFAULT '',
    ADD COLUMN stream_watch  text NOT NULL DEFAULT '';
