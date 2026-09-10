-- Initial schema. Webinars only — no meetings.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Hosts and panelists have accounts. Attendees deliberately do not: their
-- registration join key is the credential, like Zoom's personal join link.
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    password_hash text,
    name          text NOT NULL,
    title         text NOT NULL DEFAULT '',
    org           text NOT NULL DEFAULT '',
    initials      text NOT NULL DEFAULT '',
    hue           text NOT NULL DEFAULT '#0b5cff',
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE webinars (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          text NOT NULL UNIQUE,
    webinar_id    text NOT NULL UNIQUE,
    topic         text NOT NULL,
    summary       text NOT NULL DEFAULT '',
    description   text NOT NULL DEFAULT '',
    track         text NOT NULL DEFAULT '',

    starts_at     timestamptz NOT NULL,
    duration_min  integer NOT NULL CHECK (duration_min > 0),
    time_zone     text NOT NULL DEFAULT 'UTC',

    kind          text NOT NULL DEFAULT 'live'      CHECK (kind IN ('live','simulive','recurring')),
    status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended','draft')),

    host_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    registration_required boolean NOT NULL DEFAULT true,
    approval      text NOT NULL DEFAULT 'automatic' CHECK (approval IN ('automatic','manual')),
    attendee_limit integer NOT NULL DEFAULT 500 CHECK (attendee_limit > 0),
    price_cents   integer CHECK (price_cents IS NULL OR price_cents >= 0),
    passcode      text NOT NULL DEFAULT '',

    agenda        jsonb NOT NULL DEFAULT '[]'::jsonb,
    takeaways     jsonb NOT NULL DEFAULT '[]'::jsonb,
    options       jsonb NOT NULL DEFAULT '{}'::jsonb,
    report        jsonb,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webinars_browse_idx ON webinars (status, starts_at);
CREATE INDEX webinars_host_idx ON webinars (host_id, starts_at);

CREATE TABLE webinar_panelists (
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (webinar_id, user_id)
);

CREATE TABLE custom_questions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    key        text NOT NULL,
    label      text NOT NULL,
    type       text NOT NULL DEFAULT 'short' CHECK (type IN ('short','select','checkbox')),
    required   boolean NOT NULL DEFAULT false,
    options    jsonb NOT NULL DEFAULT '[]'::jsonb,
    position   integer NOT NULL DEFAULT 0,
    UNIQUE (webinar_id, key)
);

CREATE TABLE registrations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    email       text NOT NULL,
    first_name  text NOT NULL DEFAULT '',
    last_name   text NOT NULL DEFAULT '',
    company     text NOT NULL DEFAULT '',
    job_title   text NOT NULL DEFAULT '',
    country     text NOT NULL DEFAULT '',
    answers     jsonb NOT NULL DEFAULT '{}'::jsonb,
    state       text NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','pending','declined')),
    -- The join key is a bearer credential, so it is unique and indexed for
    -- constant-time lookup on the join path.
    join_key    text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- One registration per person per webinar; re-registering returns the original.
CREATE UNIQUE INDEX registrations_webinar_email_key ON registrations (webinar_id, lower(email));
CREATE INDEX registrations_webinar_state_idx ON registrations (webinar_id, state, created_at DESC);
