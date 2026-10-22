/* What the AI wrote about one session for its host, cached so opening Results never asks
 * the model again (api/internal/api/leads.go, followups.go).
 *
 * One row per webinar and kind:
 *   leads              the one-line reason beside each top lead: body is {"reasons": {key: text}}
 *   followups:en       the follow-up drafts per group, in English
 *   followups:hinglish the same in Hinglish (Roman script)
 *
 *   ended_at       the session end the row was written for. A session restarted and ended
 *                  again has a new end, and the row is written once more for it; otherwise
 *                  never (there is no regenerate).
 *   edits          the host's own edits to the drafts, per group, kept apart from what the
 *                  model wrote so an edit is never lost to a rewrite.
 *   claimed_until  a request writing the row, so two tabs opening Results make one call.
 */
CREATE TABLE session_ai_outputs (
    webinar_id    uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('leads', 'followups:en', 'followups:hinglish')),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    ended_at      timestamptz,
    body          jsonb,
    edits         jsonb NOT NULL DEFAULT '{}'::jsonb,
    model         text NOT NULL DEFAULT '',
    claimed_until timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    generated_at  timestamptz,
    PRIMARY KEY (webinar_id, kind)
);
