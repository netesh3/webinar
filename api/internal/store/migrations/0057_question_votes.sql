-- Q&A that survives a reload.
--
-- session_questions.upvotes was a bare counter, so a rejoining attendee could not be
-- told they had already voted (the button came back) and every re-click counted again.
-- One row per (question, voter) makes the vote idempotent and "votedByMe" answerable.
CREATE TABLE IF NOT EXISTS session_question_votes (
    question_id text NOT NULL REFERENCES session_questions(id) ON DELETE CASCADE,
    identity    text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (question_id, identity)
);

-- The asker's role, so a question listed after a reload keeps its Host / Panelist badge.
ALTER TABLE session_questions ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'attendee';
