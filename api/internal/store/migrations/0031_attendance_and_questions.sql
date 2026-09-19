-- Join/leave intervals for the post-session report, and a durable Q&A log.
-- Questions used to live only on the data channel; ending the webinar wiped them.

CREATE TABLE attendance (
    webinar_id      uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity        text NOT NULL,
    registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,
    first_joined_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, identity)
);

CREATE INDEX attendance_webinar_idx ON attendance (webinar_id);

CREATE TABLE session_questions (
    id          text PRIMARY KEY,
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity    text NOT NULL DEFAULT '',
    name        text NOT NULL DEFAULT '',
    body        text NOT NULL,
    anonymous   boolean NOT NULL DEFAULT false,
    answered    boolean NOT NULL DEFAULT false,
    answer      text NOT NULL DEFAULT '',
    pinned      boolean NOT NULL DEFAULT false,
    dismissed   boolean NOT NULL DEFAULT false,
    upvotes     integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_questions_webinar_idx
    ON session_questions (webinar_id, created_at);
