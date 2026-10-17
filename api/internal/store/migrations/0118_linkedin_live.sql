/* LinkedIn Live: a destination the host saves once, in Settings.
 *
 * users.linkedin_ingest is the RTMP(S) URL with the stream key on the path, the
 * same shape as webinars.stream_ingest and kept as carefully: it never leaves
 * the database except toward LiveKit Egress. Empty means LinkedIn is not set up.
 *
 * webinars.linkedin_paused is the host pressing Pause in one room. Saved
 * details stream every live webinar by default; pausing stops that one only,
 * and the next webinar streams again.
 */
ALTER TABLE users
    ADD COLUMN linkedin_ingest text NOT NULL DEFAULT '',
    ADD COLUMN linkedin_set_at timestamptz;

ALTER TABLE webinars
    ADD COLUMN linkedin_paused boolean NOT NULL DEFAULT false;
