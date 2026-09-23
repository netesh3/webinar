-- Broadcasts: one message a host writes once and sends to many people.
--
-- The difference from a reminder is who decided to send it. A reminder is this
-- application telling somebody about a webinar they registered for; a broadcast is
-- the host's own message to their list, at a moment they chose. That is why there
-- is a table for it at all: the message, its audience and the time it goes out are
-- facts about the broadcast, not about any one recipient.
--
-- The recipients themselves are NOT here. They are rows in `notifications`, one per
-- person, exactly like a reminder — same outbox, same due_at, same attempts and
-- backoff, same consent re-check at send time. A `crm_broadcast_recipients` table
-- would be a second answer to "was this person told", and the first answer is
-- already the one every other channel uses. See 0044 for the argument in full.
--
-- What this does add is a pointer in both directions: `notifications.broadcast_id`
-- so a queued message knows which broadcast it belongs to, and
-- `crm_messages.broadcast_id` so the conversation row does too. The second is what
-- makes stats possible: delivered and read only ever arrive by webhook, against a
-- message, long after the outbox row was marked sent.

CREATE TABLE crm_broadcasts (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The host's label, for the list. Never sent to anybody, which is why it has no
    -- length or content rules beyond being present.
    name     text NOT NULL,

    -- Name AND language: a template's identity at Meta. Not a foreign key to
    -- crm_templates for the same reason crm_reminder_templates is not — that table
    -- is a cache of what Meta last said, and a sync that temporarily loses a
    -- template must not delete the history of a broadcast that used it.
    template_name     text NOT NULL,
    template_language text NOT NULL,

    -- What fills each {{n}}, in order, as the host configured it: either a literal
    -- string or a merge token. Kept unresolved so the broadcast can be read back as
    -- it was written; the resolved values live on each recipient's outbox row.
    params   jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Who it went to. Deliberately a short list of sets this server can resolve
    -- itself: there is no "upload a CSV", because a phone number nobody in our
    -- records consented to is the one thing that gets a host's WABA banned.
    audience text NOT NULL CHECK (audience IN ('opted_in','webinar')),

    -- The webinar this message is about. The audience when `audience = 'webinar'`,
    -- and the source of the topic/when merge fields either way. SET NULL rather than
    -- CASCADE: deleting a webinar must not delete the record of messages already
    -- sent about it.
    webinar_id uuid REFERENCES webinars(id) ON DELETE SET NULL,

    -- When the recipients' rows come due. Stored as well as copied onto them, so a
    -- broadcast whose rows have all been sent still knows when it was meant to go.
    scheduled_at timestamptz NOT NULL,

    /* Cancelled, and nothing else.
     *
     * There is no status column. Every other state a broadcast could be in —
     * scheduled, part-way through, finished — is a fact about its queued messages,
     * and storing it here as well would create the usual second answer: a row that
     * says 'sent' while three of its messages are still pending because Meta was
     * rate-limiting an hour ago. Cancelling is different, because it is the one
     * thing a host DID and nothing in the outbox records it. */
    canceled_at timestamptz,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT crm_broadcasts_needs_a_webinar
        CHECK (audience <> 'webinar' OR webinar_id IS NOT NULL)
);

-- Every read is "this host's broadcasts, newest first".
CREATE INDEX crm_broadcasts_host_idx ON crm_broadcasts (host_id, created_at DESC);

-- The recipient rows, in the outbox that already exists.
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES crm_broadcasts(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'approval_requested',
    'registration_approved',
    'registration_declined',
    'registration_confirmed',
    'reminder_24h',
    'reminder_1h',
    'wa_registration_confirmed',
    'wa_reminder_24h',
    'wa_reminder_1h',
    -- One recipient of one broadcast. Its own kind rather than a reminder with a
    -- broadcast_id, because the reminder kinds are swept, rescheduled and skipped by
    -- name in half a dozen statements — a webinar being moved rewrites the due time
    -- of a reminder, and must not touch a broadcast the host scheduled for Friday.
    'wa_broadcast'
));

-- A broadcast row is the only kind with a broadcast_id, and the only kind without a
-- registration. Stated rather than assumed: the queries that sweep reminders lean on
-- "no broadcast_id" to mean "not a broadcast".
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_broadcast_shape;
ALTER TABLE notifications ADD CONSTRAINT notifications_broadcast_shape CHECK (
    (kind = 'wa_broadcast') = (broadcast_id IS NOT NULL)
);

-- One message per person per broadcast. The same reasoning as the per-registration
-- index in 0044, with more at stake: a duplicate here is a duplicate on somebody's
-- phone AND on the host's bill, multiplied by the size of their list.
CREATE UNIQUE INDEX notifications_one_per_broadcast
    ON notifications (broadcast_id, contact_id)
    WHERE broadcast_id IS NOT NULL;

-- Stats read every row of one broadcast, grouped by delivery.
CREATE INDEX notifications_broadcast_idx
    ON notifications (broadcast_id, delivery)
    WHERE broadcast_id IS NOT NULL;

/* Which broadcast a conversation row came from.
 *
 * SET NULL, unlike the outbox rows above: a queued message belongs to its broadcast
 * and means nothing without it, but a message that was actually delivered to
 * somebody is part of the conversation with that person for ever, and deleting the
 * broadcast must not rewrite their thread. */
ALTER TABLE crm_messages
    ADD COLUMN IF NOT EXISTS broadcast_id uuid REFERENCES crm_broadcasts(id) ON DELETE SET NULL;

-- Delivered and read are counted from here, by broadcast.
CREATE INDEX crm_messages_broadcast_idx
    ON crm_messages (broadcast_id, status)
    WHERE broadcast_id IS NOT NULL;
