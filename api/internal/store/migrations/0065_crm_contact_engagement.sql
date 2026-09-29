/* Engagement across webinars, per person: the Audience tab's rollup.
 *
 * One row per contact per host, refreshed from the person's saved per-webinar scores
 * (engagement_scores) whenever a webinar they registered for is scored, and when they
 * register. Refreshed, never incremented: a recompute, a tier that moved or a formula change
 * can't double-count, and running it twice gives the same row.
 *
 * The Audience tab only reads it: its numbers and lists are indexed counts on this table,
 * so nothing is recomputed when a coach opens the page.
 */
CREATE TABLE crm_contact_engagement (
    host_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id       uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    -- Webinars they registered for, and joined (declined seats excluded).
    registered       int NOT NULL DEFAULT 0,
    attended         int NOT NULL DEFAULT 0,
    -- Average and latest engagement score over the webinars they joined; 0 when none.
    avg_score        smallint NOT NULL DEFAULT 0,
    last_score       smallint NOT NULL DEFAULT 0,
    last_tier        text NOT NULL DEFAULT '',
    best_tier        text NOT NULL DEFAULT '',
    watch_min        int NOT NULL DEFAULT 0,
    last_webinar_id  uuid REFERENCES webinars(id) ON DELETE SET NULL,
    last_attended_at timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, contact_id)
);
CREATE INDEX crm_contact_engagement_attended_idx ON crm_contact_engagement (host_id, attended, avg_score DESC);
