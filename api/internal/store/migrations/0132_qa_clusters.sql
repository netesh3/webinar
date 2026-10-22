-- The AI Q&A assistant (api/internal/api/qa_assist.go): questions that ask the same thing,
-- grouped into one cluster with a short canonical wording, for the host's Q&A panel.
--
-- Persisted so a refresh, or a second host, sees the same clusters the first one did, and so
-- a question is grouped once rather than on every read. cluster_id NULL is "not grouped yet":
-- what the batching trigger counts. A cluster is never shown to the audience.
CREATE TABLE session_qa_clusters (
    id          text PRIMARY KEY,
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    canonical   text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_qa_clusters_webinar_idx ON session_qa_clusters (webinar_id);

ALTER TABLE session_questions
    ADD COLUMN cluster_id text REFERENCES session_qa_clusters(id) ON DELETE SET NULL;

-- When a grouping pass last stopped at an AI cap, so the host's panel can say so and the
-- trigger does not knock on the cap with every question.
CREATE TABLE session_qa_state (
    webinar_id  uuid PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
    limited_at  timestamptz
);
