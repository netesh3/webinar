-- AI knowledge (api/internal/api/knowledge.go): a host's library of documents that grounds the
-- live Q&A assistant's draft answers.
--
-- The account owns the library and every session uses all of it, except the documents a host
-- unticks for that session (session_knowledge_exclusions: an exclude list, so a document added
-- later is on everywhere by default). Only the extracted text is kept, never the uploaded file:
-- the library is capped in words (types.KnowledgeMax*), not against the media quota.
CREATE TABLE knowledge_docs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       text NOT NULL,
    -- text (pasted), txt, md, pdf or docx.
    source      text NOT NULL,
    filename    text NOT NULL DEFAULT '',
    -- The uploaded file's size; 0 for pasted text.
    bytes       bigint NOT NULL DEFAULT 0,
    body        text NOT NULL,
    words       integer NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_docs_host_idx ON knowledge_docs (host_id, created_at DESC);

-- A document in overlapping ~400-word pieces, each searchable on its own. 'simple' rather than
-- 'english': no stemming and no stop words, so Hinglish and Roman Hindi ("fees kitni hai")
-- match as typed.
CREATE TABLE knowledge_chunks (
    doc_id  uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    seq     integer NOT NULL,
    body    text NOT NULL,
    -- Estimated model tokens, for the retrieval budget.
    tokens  integer NOT NULL,
    tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, body)) STORED,
    PRIMARY KEY (doc_id, seq)
);

CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);

CREATE TABLE session_knowledge_exclusions (
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    doc_id      uuid NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    PRIMARY KEY (webinar_id, doc_id)
);

-- A draft answer for one question or cluster, for the host team only, until a host posts it
-- (through the ordinary answer path) or discards it. cluster_key is a cluster id, or "q_" + a
-- question id for a question no pass has grouped. auto is a draft the assistant wrote unasked
-- (capped per session); sources are the titles of the documents it drew on.
CREATE TABLE session_qa_drafts (
    id           text PRIMARY KEY,
    webinar_id   uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    cluster_key  text NOT NULL,
    answer       text NOT NULL,
    grounded     boolean NOT NULL,
    sources      text[] NOT NULL DEFAULT '{}',
    auto         boolean NOT NULL DEFAULT false,
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'discarded')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_qa_drafts_webinar_idx ON session_qa_drafts (webinar_id, cluster_key);
