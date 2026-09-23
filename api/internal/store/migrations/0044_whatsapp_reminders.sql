-- WhatsApp reminders ride the notifications outbox, and the host's chosen
-- templates get a table of their own.
--
-- ONE OUTBOX, not a second queue. The reasoning in 0010 applies unchanged: the
-- question a host asks is "was this person told", and two tables would give two
-- answers to it. A WhatsApp reminder is the same fact as an email reminder with a
-- different transport, so it is the same row with a different channel — which
-- also means the existing due_at, attempts and backoff behaviour are already
-- correct for it, and that reminders move when a webinar is rescheduled without
-- anything new being written.
--
-- What WhatsApp needs on top of email: a contact to send to (a phone number that
-- belongs to a host's CRM, not a bare address), and a template rather than a
-- subject and body. Meta will not accept our own words outside a 24-hour window
-- the contact has to open first, so a reminder — which by definition arrives when
-- nobody has written in — can only ever be an approved template.
ALTER TABLE notifications
    -- 'email' for every existing row, which is what they all are.
    ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email'
        CHECK (channel IN ('email','whatsapp')),

    -- The recipient of a WhatsApp row. CASCADE rather than SET NULL: a contact
    -- deleted from the CRM has no number left to send to, and the row would be
    -- undeliverable rather than merely unattributed.
    ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES crm_contacts(id) ON DELETE CASCADE,

    -- What to send. Name AND language, because that pair is a template's identity
    -- at Meta: the same name is approved once per translation.
    ADD COLUMN IF NOT EXISTS template_name text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS template_language text NOT NULL DEFAULT '',

    -- The values for the template's {{1}}, {{2}} … already resolved, in order.
    -- Resolved at enqueue time rather than at send time so the row is a record of
    -- what was promised: a webinar renamed an hour before it starts must not
    -- silently change the reminder that has already been composed. jsonb rather
    -- than text[] because it is read and written whole, never queried into.
    ADD COLUMN IF NOT EXISTS template_params jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
    'approval_requested',
    'registration_approved',
    'registration_declined',
    'registration_confirmed',
    'reminder_24h',
    'reminder_1h',
    -- The WhatsApp half. Named apart from their email counterparts rather than
    -- distinguished only by `channel`, so the one-per-registration indexes below
    -- cannot make a confirmation email and a confirmation message compete for the
    -- same slot — a host may well want both.
    'wa_registration_confirmed',
    'wa_reminder_24h',
    'wa_reminder_1h'
));

-- Recipients, now three shapes. A WhatsApp row is addressed to a contact and has
-- neither a user_id nor an email, which the original constraint forbade.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_has_one_recipient;
ALTER TABLE notifications ADD CONSTRAINT notifications_has_one_recipient CHECK (
    (channel = 'whatsapp' AND contact_id IS NOT NULL
                          AND template_name <> '' AND user_id IS NULL AND email = '')
    OR
    (channel = 'email' AND (
        (user_id IS NOT NULL AND email = '') OR
        (user_id IS NULL     AND email <> '')
    ))
);

-- One of each WhatsApp kind per registration. Registering twice is idempotent
-- everywhere else in this application, and Meta charges per message: a duplicate
-- here is a duplicate on somebody's phone AND on the host's bill.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_wa_per_kind_reg
    ON notifications (kind, registration_id)
    WHERE registration_id IS NOT NULL
      AND kind IN ('wa_registration_confirmed','wa_reminder_24h','wa_reminder_1h');

-- The WhatsApp sweep, which is a different slice from the email one: those rows
-- are found by `email <> ''`, and these have no email at all.
CREATE INDEX IF NOT EXISTS notifications_wa_due_idx
    ON notifications (due_at)
    WHERE delivery = 'pending' AND channel = 'whatsapp';

-- Which template a host's automatic messages use.
--
-- A host-level choice rather than a per-webinar one, and a choice rather than a
-- name we invent: a template has to be submitted to Meta and approved before it
-- can be sent to anybody, so the only names that exist are the ones this host
-- already has. There is no default and no fallback — the reminder simply is not
-- sent until a host picks one, which is the honest behaviour when the alternative
-- is naming a template Meta would reject.
--
-- One row per kind, so a confirmation and a one-hour reminder can be different
-- templates. They usually are: "you're registered" and "starting in an hour" are
-- not the same sentence.
CREATE TABLE IF NOT EXISTS crm_reminder_templates (
    host_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind     text NOT NULL CHECK (kind IN (
                 'wa_registration_confirmed','wa_reminder_24h','wa_reminder_1h')),

    -- Not a foreign key to crm_templates. That table is a cache of what Meta said
    -- last, and a sync that temporarily loses a template must not delete the
    -- host's configuration — the send path checks the name against the cache at
    -- the time it sends, which is the only moment the answer matters.
    name     text NOT NULL,
    language text NOT NULL,

    -- Which webinar or contact fact fills each {{n}}, in order. Tokens, not
    -- values: the values differ per recipient and are resolved when the row is
    -- enqueued. An empty array is correct for a template with no placeholders.
    params   jsonb NOT NULL DEFAULT '[]'::jsonb,

    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (host_id, kind)
);
