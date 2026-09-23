-- The lead CRM: who a host may message, and what has been said.
--
-- Host-scoped on users.id, like the WhatsApp grant in 0041 and for the same
-- reason: the account that owns the WABA is the account Meta bills, so it is also
-- the only sensible owner of the people it is allowed to write to. There is no
-- org model to hang these off, and inventing one here would be a bigger change
-- than the feature.
--
-- A contact is NOT a registration. Registrations belong to one webinar and are
-- immutable history — who signed up, with which answers, for which session. A
-- contact is the person behind however many of those there are, and it keeps
-- accumulating after the webinar is over. Copying a few fields across on register
-- is what links the two, and it is a copy on purpose: editing a contact's name in
-- the CRM must not rewrite the attendance record of a session that already
-- happened.

CREATE TABLE crm_contacts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- E.164, normalised by the same normalisePhone the registration form's number
    -- goes through, so the CRM and the registration cannot disagree about whether
    -- "+27 82 000 0000" and "0027820000000" are one person.
    phone      text NOT NULL DEFAULT '',
    email      text NOT NULL DEFAULT '',
    name       text NOT NULL DEFAULT '',
    company    text NOT NULL DEFAULT '',

    -- Where this person came from: 'registration' today, 'whatsapp' for someone
    -- who wrote to the host's number first, 'import'/'manual' later. Kept as free
    -- text rather than an enum because a new source is a product decision, not a
    -- migration.
    source     text NOT NULL DEFAULT '',

    -- The registration that first created this contact, and only the first: a
    -- person who attends four webinars is still one contact, and overwriting this
    -- each time would turn "where did this lead come from" into "which webinar was
    -- most recent", which last_seen_at already answers. SET NULL rather than
    -- CASCADE — deleting a registration must not delete the lead.
    registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,

    -- Consent, as two timestamps rather than one boolean, because WHEN is the part
    -- that matters if Meta or a regulator ever asks. Opt-out wins whenever it is
    -- the later of the two, which is what lets someone re-subscribe without
    -- needing the earlier refusal erased.
    whatsapp_opt_in_at  timestamptz,
    whatsapp_opt_out_at timestamptz,

    -- Last inbound or outbound activity, so an inbox can sort by "who is waiting"
    -- instead of by when the row happened to be created.
    last_seen_at timestamptz,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per host, enforced twice because a contact can arrive with
-- either identifier and not the other.
--
-- Partial indexes: both columns default to '', and '' is not an identity. Plain
-- UNIQUE constraints would let the first phone-less contact block every
-- subsequent one, which is exactly the shape of bug that shows up only once a
-- host has more than one lead.
CREATE UNIQUE INDEX crm_contacts_host_phone_key ON crm_contacts (host_id, phone)
    WHERE phone <> '';
CREATE UNIQUE INDEX crm_contacts_host_email_key ON crm_contacts (host_id, lower(email))
    WHERE email <> '';
-- The contacts list and the inbox both read "this host's people, most recent
-- first". NULLS LAST so a contact who has never messaged sorts below one who has,
-- rather than above everyone on a NULL.
CREATE INDEX crm_contacts_host_recent_idx ON crm_contacts (host_id, last_seen_at DESC NULLS LAST);

-- The conversation, as one flat table.
--
-- The plan called for crm_conversations alongside this; it is not here, because a
-- thread is (host, contact) and nothing else — one host has one WhatsApp number,
-- and a table whose only content is the pair it is keyed by earns nothing but a
-- join. When a host can connect several numbers, the thread stops being derivable
-- and that table becomes worth adding.
CREATE TABLE crm_messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,

    -- From the host's point of view: 'in' is the contact writing to the business.
    direction  text NOT NULL CHECK (direction IN ('in','out')),
    -- The rendered text. For a template send it is what the contact will actually
    -- read, so the inbox does not show a host the name of a template and call it a
    -- conversation.
    body       text NOT NULL DEFAULT '',
    -- Unsupported inbound kinds (image, audio, location, a button tap) keep their
    -- Meta type here so the thread can say "sent an image" rather than showing a
    -- blank line. Empty for plain text.
    kind       text NOT NULL DEFAULT '',
    template_name text NOT NULL DEFAULT '',

    -- Meta's message id. The idempotency key for the whole ingest path: Meta
    -- retries a delivery it did not see a 2xx for, and retries are how a webhook
    -- that works turns into a thread with every message in it twice.
    wamid      text NOT NULL DEFAULT '',

    -- Lifecycle of an outbound message, driven by webhook statuses. Inbound rows
    -- are written 'delivered' — they arrived, and there is nothing further to
    -- report about them.
    status     text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','delivered','read','failed')),
    -- Meta's own words when status is 'failed' — "no payment method on this WABA"
    -- is the host's problem to fix and ours to repeat accurately.
    error      text NOT NULL DEFAULT '',

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- Partial again: an outbound row exists before Meta has given it an id.
CREATE UNIQUE INDEX crm_messages_wamid_key ON crm_messages (host_id, wamid)
    WHERE wamid <> '';
-- Reading one thread, oldest first, is the only query this table has.
CREATE INDEX crm_messages_thread_idx ON crm_messages (contact_id, created_at);
