/* Retention for chat images and live captions.
 *
 * Chat image files lived for as long as the webinar did; recording retention
 * (RECORDINGS_RETENTION_DAYS) never touched them. They are now deleted that many
 * days after the webinar ends. The message row stays, and so does media_key:
 * engagement scoring reads it as an image's stand-in body (store/engagement.go),
 * so clearing it would change a recomputed score. media_expired_at says the file
 * is gone, and the media endpoint answers 410.
 *
 * session_captions kept one row per caption segment for ever, and the transcript
 * export rebuilt it from them on every download. Thirty days after the webinar
 * ends the transcript is built once into webinar_transcripts and the rows are
 * deleted; the export then serves the stored text.
 */
ALTER TABLE chat_messages ADD COLUMN media_expired_at timestamptz;

CREATE INDEX chat_messages_stored_media ON chat_messages (webinar_id)
    WHERE media_key IS NOT NULL AND media_key <> '' AND media_expired_at IS NULL;

CREATE TABLE webinar_transcripts (
    webinar_id uuid PRIMARY KEY REFERENCES webinars (id) ON DELETE CASCADE,
    body       text NOT NULL,
    truncated  boolean NOT NULL DEFAULT false,
    built_at   timestamptz NOT NULL DEFAULT now()
);
