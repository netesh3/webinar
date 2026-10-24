/* Load tests (docs/LOAD-TESTING.md): an admin marks one webinar as a load test, and only then
 * may the admin mint name-only viewer seats for it and let more viewers in than the plan
 * ceiling. Off by default: no row, no effect. The row goes with the webinar.
 *
 * Only a webinar whose host is a test account (an email ending .invalid, which cannot receive
 * mail and so can never be a customer's) can be marked; the API checks that, not this table. */
CREATE TABLE load_tests (
    webinar_id  uuid PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
    -- The most viewers the test admits at once, in place of the plan's attendee ceiling.
    viewers     integer NOT NULL CHECK (viewers BETWEEN 1 AND 5000),
    enabled_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE load_tests ENABLE ROW LEVEL SECURITY;
