-- Notifications: the host's alert when somebody is waiting, and the invitation a
-- registrant gets when they are let in.
--
-- The approval workflow already worked without this — a pending registration appeared in the
-- host's registrants tab and an approved one unlocked the join button. What was missing was
-- anybody being TOLD. A host had to think to go and look, and an approved registrant had no
-- way to learn they had been approved short of revisiting the page. For a webinar that opens
-- in fifteen minutes, "check back later" is not a workflow.
--
-- ONE TABLE FOR BOTH the in-app alert and the email, rather than a notifications table and a
-- separate mail queue. They carry the same facts and differ only in delivery, and two tables
-- would mean two sources of truth about whether a person was told — which is exactly the
-- question you want a single answer to when a registrant says nobody ever contacted them.
--
-- It is therefore an OUTBOX, not a log. A row is written in the same transaction as the thing
-- it describes, so a notification cannot be lost because the process died between committing
-- the approval and sending the mail. Delivery is a separate step that reads this table.
CREATE TABLE notifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Who it is for. Exactly one of these is set, and the CHECK below enforces it.
    --
    -- user_id for a host alert: hosts have accounts, so the alert follows them to any
    -- browser and can be counted for a badge.
    --
    -- email for a registrant invitation: a guest who registered without an account has no
    -- user_id, and that is the whole point of the guest flow. The address is denormalised
    -- rather than joined through registration_id because an invitation must remain
    -- explicable after the registration is deleted — "we emailed this address" is the
    -- record, and a cascade would erase the evidence.
    user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
    email       text NOT NULL DEFAULT '',

    kind        text NOT NULL CHECK (kind IN ('approval_requested','registration_approved','registration_declined')),

    -- Context for rendering, kept as columns rather than a jsonb blob because every consumer
    -- needs all of them and a blob would make "which webinar was this about" unqueryable.
    webinar_id  uuid REFERENCES webinars(id) ON DELETE CASCADE,
    subject     text NOT NULL,
    body        text NOT NULL,

    -- Delivery state. 'pending' means owed, and it is the default so that forgetting to set
    -- it cannot silently mean "already handled".
    --
    -- 'skipped' is deliberately not 'failed': it records that no transport was configured,
    -- which is an operator decision rather than an error, and conflating the two would bury
    -- real send failures under routine noise on a deployment with no SMTP credentials.
    delivery    text NOT NULL DEFAULT 'pending'
                CHECK (delivery IN ('pending','sent','failed','skipped')),
    delivery_error text NOT NULL DEFAULT '',
    delivered_at   timestamptz,

    -- The in-app half. NULL until the host has seen it; a timestamp rather than a boolean
    -- because "when did they notice" answers questions a flag cannot.
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT notifications_has_one_recipient CHECK (
        (user_id IS NOT NULL AND email = '') OR
        (user_id IS NULL     AND email <> '')
    )
);

-- The badge query: unread, for one host, newest first. Partial on read_at IS NULL because
-- that is the only slice anything reads often, and it keeps the index small as the table
-- grows past the notifications nobody will look at again.
CREATE INDEX notifications_unread_idx
    ON notifications (user_id, created_at DESC)
 WHERE read_at IS NULL AND user_id IS NOT NULL;

-- The delivery sweep: everything still owed, oldest first, so a backlog drains in the order
-- it arrived rather than newest-first.
CREATE INDEX notifications_pending_idx
    ON notifications (created_at)
 WHERE delivery = 'pending';
