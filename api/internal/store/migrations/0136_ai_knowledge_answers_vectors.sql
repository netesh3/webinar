-- AI knowledge, part two (api/internal/api/knowledge_answers.go, knowledge_vault.go,
-- knowledge_embed.go): past answers harvested from ended sessions, Obsidian vault imports,
-- and hybrid (full-text + vector) retrieval.
--
-- pgvector. Production is Supabase, which ships it; CI runs pgvector/pgvector:pg18.
CREATE EXTENSION IF NOT EXISTS vector;

-- A vault note's folder inside the vault ("Course/Week 1"), shown as a tag; '' otherwise.
ALTER TABLE knowledge_docs ADD COLUMN folder text NOT NULL DEFAULT '';

-- text-embedding-3-small, 1536 dimensions, stored as halfvec (16-bit floats, pgvector 0.7+):
-- 3 KB a row instead of 6 KB, and half the index, for a recall loss too small to measure at
-- this size. NULL until embedded: a chunk added while the embedder was unavailable is
-- backfilled lazily, and is found by full-text search meanwhile.
ALTER TABLE knowledge_chunks ADD COLUMN embedding halfvec(1536);

/* HNSW rather than ivfflat. ivfflat clusters the rows that exist when the index is built:
 * built here, on a table with no embeddings yet, its lists would be meaningless until a
 * REINDEX nobody would remember to run. HNSW needs no training, takes inserts as they come,
 * and has the better recall/speed curve at this size. Every search is filtered to one host's
 * rows, so the query enables pgvector 0.8's iterative scan (hnsw.iterative_scan) to keep
 * going past the first ef_search neighbours until the filtered LIMIT is filled. */
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks
    USING hnsw (embedding halfvec_cosine_ops);

-- "Past answers": a host's answers to questions asked in their sessions, one Q/A per entry.
-- Only the question and the answer are kept (phones and emails scrubbed), never who asked.
--
--   typed     a host answered it in the Q&A panel: approved at once, it was already posted.
--   aloud     drafted by the AI from the transcript, for a question answered out loud: pending
--             until the host approves it. Pending entries are never retrieved.
--
-- A repeat (a new approved answer to a question an entry already holds) updates that entry;
-- prev_* keep the version it replaced, for one Undo.
CREATE TABLE knowledge_answers (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question           text NOT NULL,
    answer             text NOT NULL,
    status             text NOT NULL CHECK (status IN ('approved', 'pending')),
    origin             text NOT NULL CHECK (origin IN ('typed', 'aloud')),
    -- Where the current text came from. The topic and date are copied, so the label survives
    -- the session being deleted.
    source_webinar_id  uuid REFERENCES webinars(id) ON DELETE SET NULL,
    source_topic       text NOT NULL DEFAULT '',
    source_at          timestamptz,
    -- The version a repeat replaced, kept for one Undo; NULL when there is none.
    prev_question      text,
    prev_answer        text,
    prev_topic         text,
    prev_at            timestamptz,
    prev_webinar_id    uuid REFERENCES webinars(id) ON DELETE SET NULL,
    -- The question, embedded: what repeats are matched on and what retrieval compares with.
    embedding          halfvec(1536),
    tsv                tsvector GENERATED ALWAYS AS
                         (to_tsvector('simple'::regconfig, question || ' ' || answer)) STORED,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_answers_host_idx ON knowledge_answers (host_id, status, updated_at DESC);
CREATE INDEX knowledge_answers_tsv_idx ON knowledge_answers USING gin (tsv);
CREATE INDEX knowledge_answers_embedding_idx ON knowledge_answers
    USING hnsw (embedding halfvec_cosine_ops);

-- Every session question (or cluster) a harvest has already turned into an entry, merged into
-- one, or drafted: what makes a harvest idempotent, and keeps an entry the host deleted or
-- skipped from coming back on the next visit.
CREATE TABLE knowledge_answer_sources (
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    source_key  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, source_key)
);

-- One row per ended session the harvest has looked at. aloud_at is set when the
-- answered-aloud pass is claimed (once per session, whatever the outcome), aloud_reason says
-- how it went: drafted, none (nothing to draft), no_transcript, ai_off, limit, failed.
CREATE TABLE knowledge_harvests (
    webinar_id    uuid PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
    host_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    typed_at      timestamptz,
    aloud_at      timestamptz,
    aloud_reason  text NOT NULL DEFAULT ''
);

-- Sessions that leave the past answers out (the "Past answers" tick on the session's
-- knowledge card, on by default: an exclude list, like session_knowledge_exclusions).
CREATE TABLE session_past_answers_off (
    webinar_id  uuid PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE
);
