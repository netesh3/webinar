-- YouTube OAuth for a host account, plus the broadcast id of a live this
-- webinar created through that grant.
--
-- youtube_refresh never leaves the database except toward Google's token
-- endpoint. The channel title is what Account settings shows. youtube_stream_id
-- is a reusable YouTube encoder so Studio is not a new key every session.

ALTER TABLE users
    ADD COLUMN youtube_refresh       text NOT NULL DEFAULT '',
    ADD COLUMN youtube_channel_id    text NOT NULL DEFAULT '',
    ADD COLUMN youtube_channel_title text NOT NULL DEFAULT '',
    ADD COLUMN youtube_stream_id     text NOT NULL DEFAULT '';

ALTER TABLE webinars
    ADD COLUMN youtube_broadcast_id text NOT NULL DEFAULT '';
