-- A recurring series is one schedule and one registration, with a webinar row
-- per session so each occurrence has its own room, go-live, and audience.
--
-- series_exception marks a session edited on its own. A later "this and
-- following" save skips those rows instead of writing over the exception.
-- occurrence_index is the position at creation (1-based) and may gap after
-- a future session is removed.

CREATE TABLE webinar_series (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    pattern       text NOT NULL CHECK (pattern IN ('daily', 'weekly', 'monthly')),
    interval_n    integer NOT NULL CHECK (interval_n >= 1 AND interval_n <= 99),
    weekdays      integer[] NOT NULL DEFAULT '{}',
    monthly_day   smallint CHECK (monthly_day IS NULL OR (monthly_day >= 1 AND monthly_day <= 31)),
    ends          text NOT NULL CHECK (ends IN ('by_date', 'after_count')),
    end_date      date,
    end_count     integer CHECK (end_count IS NULL OR (end_count >= 1 AND end_count <= 60)),
    time_zone     text NOT NULL,
    skipped_months text[] NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (ends = 'by_date' AND end_date IS NOT NULL)
        OR (ends = 'after_count' AND end_count IS NOT NULL)
    )
);

ALTER TABLE webinars
    ADD COLUMN series_id uuid REFERENCES webinar_series(id) ON DELETE SET NULL,
    ADD COLUMN occurrence_index integer,
    ADD COLUMN series_exception boolean NOT NULL DEFAULT false;

CREATE INDEX webinars_series_idx ON webinars (series_id, starts_at);
