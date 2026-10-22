/* The AI recap of a session (api/internal/api/recap.go, api/internal/aiwrite/recap.go).
 *
 * One row per webinar or meeting, written the moment the session ends (status pending) and
 * filled in by the recap lane of the background tick. The row existing is what makes the
 * whole thing idempotent: ending a session twice, a retried tick or a second instance all
 * meet the same primary key, so there is one recap and one email per session.
 *
 *   status        pending   waiting to be written (due_at says when to look again)
 *                 ready     recap is set
 *                 skipped   nothing will be written: reason says why (ai_off, ai_limit,
 *                           ai_unavailable, empty)
 *                 failed    every attempt failed; reason has the last error
 *   wait_until    set when server captions ran: the after-session transcript arrives
 *                 some minutes after the end (the large-model pass), and until this time
 *                 the recap waits for it rather than settling for the live caption lines.
 *   source        what the recap was written from: server_transcript, captions, or
 *                 engagement_only (Q&A, polls and chat — no captions were on).
 *   emailed_at    when the host's "Your AI recap" email was queued. Set once, in the same
 *                 transaction as the outbox row, so a regenerate never mails again.
 *   claimed_until a runner working on the row, so two instances never write it at once.
 */
CREATE TABLE session_recaps (
    webinar_id    uuid PRIMARY KEY REFERENCES webinars(id) ON DELETE CASCADE,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'ready', 'skipped', 'failed')),
    reason        text NOT NULL DEFAULT '',
    due_at        timestamptz NOT NULL DEFAULT now(),
    wait_until    timestamptz,
    attempts      integer NOT NULL DEFAULT 0,
    claimed_until timestamptz,
    recap         jsonb,
    source        text CHECK (source IN ('server_transcript', 'captions', 'engagement_only')),
    model         text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    generated_at  timestamptz,
    emailed_at    timestamptz
);

CREATE INDEX session_recaps_due ON session_recaps (due_at) WHERE status = 'pending';

-- The host's recap email (and its in-app alert) is a new outbox kind.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'approval_requested',
    'registration_approved',
    'registration_declined',
    'registration_confirmed',
    'reminder',
    'wa_registration_confirmed',
    'wa_reminder',
    'wa_broadcast',
    'wa_drip',
    'replay_ready',
    'wa_replay',
    'welcome',
    'panelist_invited',
    'panelist_rescheduled',
    'panelist_cancelled',
    'email_verify',
    'password_reset',
    'host_request',
    'sales_handoff',
    'sales_reply',
    'session_recap'
));
