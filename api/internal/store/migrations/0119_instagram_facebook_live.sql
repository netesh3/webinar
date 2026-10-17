/* Instagram Live and Facebook Live: destinations saved like LinkedIn's (0118).
 *
 * Same shape per platform: <platform>_ingest is the RTMP(S) URL with the stream
 * key on the path, never sent back to the browser; <platform>_set_at is when it
 * was saved; webinars.<platform>_paused is the host pausing it in one room.
 */
ALTER TABLE users
    ADD COLUMN instagram_ingest text NOT NULL DEFAULT '',
    ADD COLUMN instagram_set_at timestamptz,
    ADD COLUMN facebook_ingest  text NOT NULL DEFAULT '',
    ADD COLUMN facebook_set_at  timestamptz;

ALTER TABLE webinars
    ADD COLUMN instagram_paused boolean NOT NULL DEFAULT false,
    ADD COLUMN facebook_paused  boolean NOT NULL DEFAULT false;
