-- Content repurposing (api/internal/api/repurpose.go): drafts written from an ended session's
-- transcript for the host to publish elsewhere, in the host's brand voice. Behind the
-- per-host switch "repurpose" (types.FeatureRepurpose), which no plan tier includes: absent
-- means off, so there is nothing to backfill.
--
-- repurpose_drafts is one format's draft for one session:
--   status         pending (queued, or being written while claimed_until is ahead),
--                  ready, failed (reason says why, in the recap's words)
--   body           what the model wrote, as Markdown. Kept through a regenerate, so the old
--                  draft stays readable until the new one replaces it.
--   edited         the host's own text, NULL until they save one. A new draft drops it.
--   reviewed_at    the host's "I've reviewed it": copy and download wait for it.
--   attempts       model calls tried for the current request; given up after a few.
--   claimed_until  a request writing it, so two polls make one call.
CREATE TABLE repurpose_drafts (
    webinar_id    uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    format        text NOT NULL CHECK (format IN ('blog', 'newsletter', 'whitepaper', 'linkedin', 'x_thread', 'instagram')),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    reason        text NOT NULL DEFAULT '',
    body          text NOT NULL DEFAULT '',
    edited        text,
    reviewed_at   timestamptz,
    model         text NOT NULL DEFAULT '',
    attempts      integer NOT NULL DEFAULT 0,
    claimed_until timestamptz,
    requested_at  timestamptz NOT NULL DEFAULT now(),
    generated_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, format)
);

-- The host's brand voice, applied to every draft. One row per account; every field optional.
CREATE TABLE brand_voices (
    user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tone       text NOT NULL DEFAULT '',
    audience   text NOT NULL DEFAULT '',
    do_words   text NOT NULL DEFAULT '',
    dont_words text NOT NULL DEFAULT '',
    sample     text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Notes on a transcript too long for one call, written once per session end and shared by
-- every format (session_ai_outputs, migrations/0130).
ALTER TABLE session_ai_outputs DROP CONSTRAINT session_ai_outputs_kind_check;
ALTER TABLE session_ai_outputs ADD CONSTRAINT session_ai_outputs_kind_check
    CHECK (kind IN ('leads', 'followups:en', 'followups:hinglish', 'repurpose_notes'));
