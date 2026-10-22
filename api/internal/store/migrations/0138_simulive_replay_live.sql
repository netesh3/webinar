-- Simulive engagement replay, part 2: real polls and quizzes, and reactions.
--
-- 1. Replayed polls are REAL polls of the simulive webinar. At the moment the original
--    opened one, a copy is inserted into the simulive's own polls table, open; at the
--    moment the original closed, the copy closes. The new audience votes in the copy
--    (poll_votes, as in any session), so Results, reports and the CRM's poll automations
--    work unchanged, and the numbers anybody sees are this audience's — the original's
--    are never read. replay_key names the original ("poll:<id>"), one copy per simulive:
--    the unique index is what makes two instances syncing at once insert it once.
--
-- 2. reaction_buckets: how many of each emoji the audience sent in each second of a
--    session. No identities, so unlike engagement_events (raw personal data, pruned
--    after 90 days) it is kept with the webinar — a recording replayed a year later
--    still has its applause. Written by the engagement capture beside the raw events.
--    Backfilled below from the raw events still on file; reactions older than the
--    retention window were pruned and cannot be recovered.
ALTER TABLE polls ADD COLUMN IF NOT EXISTS replay_key text
    CHECK (replay_key IS NULL OR length(replay_key) BETWEEN 3 AND 200);

CREATE UNIQUE INDEX IF NOT EXISTS polls_replay_key
    ON polls (webinar_id, replay_key) WHERE replay_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS reaction_buckets (
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    -- The second the reactions were sent in (date_trunc('second', ...)).
    at         timestamptz NOT NULL,
    emoji      text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
    n          integer NOT NULL CHECK (n > 0),
    PRIMARY KEY (webinar_id, at, emoji)
);

INSERT INTO reaction_buckets (webinar_id, at, emoji, n)
SELECT webinar_id, date_trunc('second', occurred_at), payload->>'emoji', count(*)
  FROM engagement_events
 WHERE kind = 'reaction' AND coalesce(payload->>'emoji', '') <> ''
   AND length(payload->>'emoji') <= 16
 GROUP BY 1, 2, 3
ON CONFLICT (webinar_id, at, emoji) DO NOTHING;
