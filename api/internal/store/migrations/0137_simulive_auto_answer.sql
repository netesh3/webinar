-- Simulive Auto mode (api/internal/api/qa_auto.go): in a simulive whose host turned it on
-- (webinars.options.simuliveAutoAnswer, account features "ai" AND "replay_engage"), a new
-- audience question the host's AI knowledge covers is answered by the assistant and posted,
-- signed "✨ <First name>'s assistant". The switch itself lives in the options JSON.
--
-- answer_by   who the posted answer is signed by when it is NOT the host team: the assistant's
--             label, exactly as the audience sees it. '' is the host team (every answer before
--             this). A host editing or replacing the answer clears it; retracting clears it with
--             the answer.
-- auto_state  where the question is in Auto mode: '' never considered (the default: asked
--             before, by the stage, or outside Auto mode), 'pending' waiting for the next batch,
--             'working' claimed by one, 'answered', 'ungrounded' (the knowledge did not cover it:
--             left open for the host), 'limited' (the session cap or the asker's rate limit),
--             'failed', 'off' (Auto mode or AI switched off before it ran), 'retracted'.
-- auto_at     when it reached its current auto_state, for the asker's rate limit.
ALTER TABLE session_questions
    ADD COLUMN IF NOT EXISTS answer_by  text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS auto_state text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS auto_at    timestamptz;

CREATE INDEX IF NOT EXISTS session_questions_auto_pending
    ON session_questions (webinar_id, created_at)
    WHERE auto_state = 'pending';
