/* Sending the AI follow-ups (api/internal/api/followup_send.go): the host reviews every
 * draft in Results and presses Send; nothing here is ever sent on its own.
 *
 * followup_sends is one row per person, session and channel: the dedupe and the
 * per-recipient status. The message itself is filed where replies thread — a WhatsApp in
 * the contact's CRM thread (crm_messages), an email in the host's email inbox
 * (host_emails) — so this table only says whether, when and how it went.
 *
 *   lead_key           the person in the session: a registration id, else the room
 *                      identity (types.Lead.Key).
 *   status             sending while a request holds it (claimed before the send, so two
 *                      tabs cannot both send), then sent or failed. A failed row may be
 *                      sent again at once; a sent row only with an explicit "send again".
 *   mode               email, or for WhatsApp freeform (inside the 24-hour window) or
 *                      template (our wl_session_followup).
 *   unsubscribe_token  the email's unsubscribe link, unguessable, kept across a resend.
 */
CREATE TABLE followup_sends (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    webinar_id        uuid        NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    host_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lead_key          text        NOT NULL,
    channel           text        NOT NULL CHECK (channel IN ('email', 'whatsapp')),
    status            text        NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
    mode              text        NOT NULL DEFAULT '',
    reason            text        NOT NULL DEFAULT '',
    address           text        NOT NULL DEFAULT '',
    unsubscribe_token text        UNIQUE,
    attempts          int         NOT NULL DEFAULT 1,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (webinar_id, lead_key, channel)
);

-- The hourly rate limit counts a host's recent sends.
CREATE INDEX followup_sends_host_recent ON followup_sends (host_id, updated_at);

/* email_unsubscribes: people who asked one host to stop emailing them follow-ups, from the
 * link in the email (or a mail client's one-click List-Unsubscribe). Per host, since the
 * relationship is with the host; the address lowercased. Checked before every follow-up
 * email, and a match is reported as skipped. */
CREATE TABLE email_unsubscribes (
    host_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, email)
);
