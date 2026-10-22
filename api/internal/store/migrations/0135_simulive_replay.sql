-- Simulive engagement replay (account feature "replay_engage").
--
-- A simulive session can replay the chat, Q&A and polls of the session its recording was
-- made in, each at the same offset into the video as it happened. Two things are needed
-- for that which did not exist:
--
-- 1. When a question was answered. session_questions only had `answered`/`answer`, so an
--    answer could not be placed on the timeline. Set the first time a question becomes
--    answered (UpdateSessionQuestion) and never moved after. Older rows stay NULL; the
--    replay shows their answer with the question.
--
-- 2. The host's curation: the items they chose to leave out of the replay, per simulive
--    webinar. A row means "hidden"; no row means shown. The key names a source row of the
--    ORIGINAL session ("chat:<id>", "question:<id>", "poll:<id>"), so picking a different
--    recording simply stops matching rather than needing a cleanup. Items moderation already
--    removed in the original (deleted chat, hidden questions) are never in the replay at all
--    and need no row here.
ALTER TABLE session_questions ADD COLUMN IF NOT EXISTS answered_at timestamptz;

CREATE TABLE IF NOT EXISTS simulive_replay_hidden (
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    item_key   text NOT NULL CHECK (length(item_key) BETWEEN 3 AND 200),
    hidden_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, item_key)
);
