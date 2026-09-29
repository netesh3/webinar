/* The computed engagement for a webinar: one summary document plus one row per attendee.
 *
 * engagement_snapshots holds the session summary (KPIs, series, polls, callouts) whole,
 * because the page reads it whole and it is bounded in size by construction — every series
 * is bucketed server-side. Keyed by formula version so a formula change never silently
 * rewrites an old webinar's number; the reader asks for the current version and computes
 * it if absent.
 *
 * engagement_scores is the per-attendee half, as rows rather than inside the document, so
 * the attendee table can be sorted, filtered and paged in SQL for a 5,000-person webinar
 * and so the CRM can select "highly engaged" registrants for a broadcast segment by
 * joining on registration_id. Replaced wholesale on each compute, inside the same
 * transaction as the snapshot, so the two never disagree.
 */
CREATE TABLE engagement_snapshots (
    webinar_id      uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    formula_version smallint NOT NULL,
    computed_at     timestamptz NOT NULL DEFAULT now(),
    payload         jsonb NOT NULL,
    PRIMARY KEY (webinar_id, formula_version)
);

CREATE TABLE engagement_scores (
    webinar_id      uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity        text NOT NULL,
    registration_id uuid REFERENCES registrations(id) ON DELETE CASCADE,
    formula_version smallint NOT NULL,
    name            text NOT NULL DEFAULT '',
    email           text NOT NULL DEFAULT '',
    score           smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
    tier            text NOT NULL CHECK (tier IN ('high', 'engaged', 'passive', 'risk')),
    watch_seconds   int NOT NULL,
    first_join_min  int NOT NULL,
    last_leave_min  int NOT NULL,
    join_timing     text NOT NULL CHECK (join_timing IN ('early', 'on_time', 'late')),
    visits          smallint NOT NULL,
    counts          jsonb NOT NULL,
    components      jsonb NOT NULL,
    presence        smallint[] NOT NULL,
    intensity       smallint[] NOT NULL,
    computed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, identity)
);

-- The attendee table's sort orders, each with identity as the stable tiebreak for paging.
CREATE INDEX engagement_scores_score_idx ON engagement_scores (webinar_id, score DESC, identity);
CREATE INDEX engagement_scores_watch_idx ON engagement_scores (webinar_id, watch_seconds DESC, identity);
CREATE INDEX engagement_scores_join_idx ON engagement_scores (webinar_id, first_join_min, identity);
CREATE INDEX engagement_scores_name_idx ON engagement_scores (webinar_id, lower(name), identity);
-- Tier filters and the CRM segment join.
CREATE INDEX engagement_scores_tier_idx ON engagement_scores (webinar_id, tier);
CREATE INDEX engagement_scores_registration_idx ON engagement_scores (registration_id)
 WHERE registration_id IS NOT NULL;
