/* engagement_events: the interactions that were relayed and never stored.
 *
 * Reactions and raised hands only ever travelled over the data channel, so a report could
 * not say who reacted or raised a hand. This is an append-only log of exactly those kinds
 * plus stage on/off (webinar_stage_grants rows are deleted on revoke, so they cannot say
 * when somebody left the stage). Chat, questions, upvotes and poll votes are NOT copied
 * here: they already have their own tables with timestamps, and a second copy would be a
 * second answer.
 *
 * Written in batches by internal/engagement/capture, never on the request path. `payload`
 * is deliberately small (the emoji, or nothing) and bounded by the CHECK so a bug cannot
 * turn this into a blob store.
 *
 * Rows are raw personal data and are pruned after the retention window (see
 * PruneEngagementEvents); the computed scores and summary outlive them.
 */
CREATE TABLE engagement_events (
    id          bigserial PRIMARY KEY,
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity    text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('reaction', 'hand_raise', 'hand_lower', 'stage_on', 'stage_off')),
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(payload) <= 256),
    occurred_at timestamptz NOT NULL
);

-- The aggregation reads one webinar's window; the drawer reads one person's timeline.
CREATE INDEX engagement_events_webinar_idx ON engagement_events (webinar_id, occurred_at);
CREATE INDEX engagement_events_identity_idx ON engagement_events (webinar_id, identity, occurred_at);
-- The retention sweep deletes by age across all webinars.
CREATE INDEX engagement_events_age_idx ON engagement_events (occurred_at);
