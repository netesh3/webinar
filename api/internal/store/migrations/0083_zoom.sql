/* One Zoom account per host, and the meeting or webinar a session runs on.
 *
 * The refresh token is ciphertext (AES-GCM). The access token is never stored.
 * zoom_start_url is the host's start link. It expires, it is not a public field,
 * and nothing in this schema should be logged.
 */
CREATE TABLE zoom_connections (
    user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    zoom_user_id text NOT NULL,
    zoom_account_id text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    refresh_token bytea NOT NULL,
    token_invalid boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX zoom_connections_zoom_user ON zoom_connections (zoom_user_id);

ALTER TABLE webinars
    ADD COLUMN venue text NOT NULL DEFAULT 'app',
    ADD COLUMN zoom_id text NOT NULL DEFAULT '',
    ADD COLUMN zoom_start_url text NOT NULL DEFAULT '';

ALTER TABLE webinars
    ADD CONSTRAINT webinars_venue_check
    CHECK (venue IN ('app', 'zoom_meeting', 'zoom_webinar'));

ALTER TABLE registrations
    ADD COLUMN zoom_registrant_id text NOT NULL DEFAULT '',
    ADD COLUMN zoom_join_url text NOT NULL DEFAULT '',
    ADD COLUMN zoom_push_error text NOT NULL DEFAULT '';
