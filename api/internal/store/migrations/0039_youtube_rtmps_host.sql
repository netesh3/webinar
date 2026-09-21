-- Destinations saved while we built RTMPS URLs against the RTMP host.
--
-- YouTube serves RTMPS from a.rtmps.youtube.com on 443 and RTMP from
-- a.rtmp.youtube.com on 1935; they are different servers, so rtmps:// against
-- the second connects to nothing and the live waits forever. The key on the
-- path is still good, so only the host is wrong.

UPDATE webinars
   SET stream_ingest = replace(stream_ingest,
                               'rtmps://a.rtmp.youtube.com/',
                               'rtmps://a.rtmps.youtube.com/')
 WHERE stream_ingest LIKE 'rtmps://a.rtmp.youtube.com/%';
