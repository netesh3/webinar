-- Drips: a sequence of messages that sends itself.
--
-- The third and last of the ways a host can message somebody on WhatsApp, and the
-- only one where nobody is present when the message goes out. A reminder is tied to
-- one webinar's clock; a broadcast is one message at a moment the host picked; a drip
-- is a rule — "whoever registers gets this, then this two days later" — that keeps
-- running for people who do not exist yet when it is written.
--
-- So there are three tables rather than one, and the split is the same one the
-- broadcast made:
--
--   crm_drips            the rule: how somebody enters, and whether it is running.
--   crm_drip_steps       the messages, in order, each with the wait before it.
--   crm_drip_enrollments one person's progress through it.
--
-- And, as in 0045, the messages themselves are NOT here. Each step that comes due is
-- written into `notifications` like everything else, with the same due_at, attempts,
-- backoff and consent re-check at send time. `notifications.drip_enrollment_id` is
-- the pointer back. A drip's own tables therefore hold no copy of "was this sent" —
-- the outbox already answers that, and a second answer is the one that ends up wrong.
--
-- The one thing that IS stored, unlike a broadcast's derived status, is why an
-- enrollment stopped. "Finished all four steps", "opted out after the second" and
-- "the host took them off it" are not derivable from anything else, and they are the
-- questions a host asks about a sequence that has been running for a month.

CREATE TABLE crm_drips (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The host's label, for their own list. Never sent to anybody.
    name    text NOT NULL,

    /* How somebody gets in.
     *
     * `trigger` would read better and is a Postgres keyword in enough contexts to
     * make every query that mentions it a small gamble; the JSON field is still
     * `trigger`.
     *
     * A short closed list, on purpose. Every one of these is an event this server
     * already records and can hook without asking anybody to define conditions:
     *
     *   manual      the host adds people themselves, one at a time.
     *   registered  somebody registers for a webinar.
     *   attended    a webinar ended and they were there.
     *   no_show     a webinar ended and they registered but never joined.
     *   ended       a webinar ended and they registered, either way.
     *
     * "Tag added" is in the plan and is not here: contacts have no tags yet. Adding
     * the trigger before the thing it fires on would be a setting that does nothing.
     */
    trigger_kind text NOT NULL CHECK (trigger_kind IN
        ('manual','registered','attended','no_show','ended')),

    /* Which webinar the trigger is about, or NULL for every webinar.
     *
     * CASCADE, unlike crm_broadcasts.webinar_id, and the difference is what the row
     * IS. A broadcast is a record of messages already sent, so deleting its webinar
     * must not delete it. A drip is a rule for the future, and the two alternatives
     * for a deleted webinar are both worse than losing the rule: SET NULL would
     * silently widen "registrants of this webinar" to "registrants of every webinar
     * I ever run", which is an accident measured in messages and money.
     */
    webinar_id uuid REFERENCES webinars(id) ON DELETE CASCADE,

    -- Paused rather than deleted. A host turning a sequence off wants it to stop
    -- taking new people AND to stop sending to the people already in it, without
    -- losing the sequence they wrote; enrollments are left where they are.
    active  boolean NOT NULL DEFAULT true,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every read is "this host's drips", and every trigger asks "which of this host's
-- drips fire on this event, for this webinar or for any".
CREATE INDEX crm_drips_host_idx ON crm_drips (host_id, created_at DESC);
CREATE INDEX crm_drips_trigger_idx ON crm_drips (trigger_kind, webinar_id) WHERE active;

CREATE TABLE crm_drip_steps (
    drip_id  uuid NOT NULL REFERENCES crm_drips(id) ON DELETE CASCADE,

    -- 0-based, and the primary key with the drip: the order IS the identity of a
    -- step. There is no separate id, because nothing ever points at one step — an
    -- enrollment stores the position it has reached, and a step edited in place is
    -- the same step.
    position integer NOT NULL CHECK (position >= 0 AND position < 50),

    /* The wait before this step, counted from the PREVIOUS one — from entering, for
     * the first. Relative rather than absolute-from-entry because that is how a host
     * thinks about a sequence ("then a day later") and, more usefully, because
     * inserting a step in the middle then does not silently move every later one.
     *
     * 0 is allowed and means "when they enter": a welcome message.
     */
    delay_minutes integer NOT NULL CHECK (delay_minutes >= 0 AND delay_minutes <= 129600),

    -- Name AND language, like everywhere else: a template's identity at Meta. Not a
    -- foreign key into the template cache, for the reason given in 0045.
    template_name     text NOT NULL,
    template_language text NOT NULL,

    -- What fills each {{n}}, as configured: a literal or a merge token, unresolved.
    -- Resolved per person when the step comes due, onto their outbox row.
    params jsonb NOT NULL DEFAULT '[]'::jsonb,

    PRIMARY KEY (drip_id, position)
);

CREATE TABLE crm_drip_enrollments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    drip_id    uuid NOT NULL REFERENCES crm_drips(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,

    /* The webinar they came in from, when they came in from one.
     *
     * Kept per enrollment and not only per drip, because a drip scoped to "any
     * webinar" still has to fill in `topic` and `when` for each person with the
     * webinar THEY registered for. SET NULL is right here, unlike on the drip: a
     * step already queued has its values resolved onto its own row, so losing the
     * webinar costs the remaining steps their topic, not their meaning.
     */
    webinar_id uuid REFERENCES webinars(id) ON DELETE SET NULL,

    -- The next step to send. 0 for somebody who has just entered; equal to the number
    -- of steps for somebody who has had all of them.
    position   integer NOT NULL DEFAULT 0 CHECK (position >= 0),

    -- active: waiting for next_due_at. done: every step sent. exited: stopped early,
    -- and exit_reason says why. Stored because "why it stopped" is not derivable.
    state      text NOT NULL DEFAULT 'active' CHECK (state IN ('active','done','exited')),
    exit_reason text NOT NULL DEFAULT '',

    -- When the step at `position` should be queued.
    next_due_at timestamptz NOT NULL DEFAULT now(),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

/* One enrollment per person per drip, ever.
 *
 * Including the finished and the exited ones, which is the point: a drip triggered
 * by "registered" fires again the next time the same person registers for anything,
 * and re-running a five-message sequence on somebody who has already had it is the
 * behaviour that gets a WABA reported. Re-entry has to be a thing a host asks for,
 * not a thing a second registration does. The insert is ON CONFLICT DO NOTHING.
 */
CREATE UNIQUE INDEX crm_drip_one_per_contact
    ON crm_drip_enrollments (drip_id, contact_id);

-- The sweep: active enrollments that are due, oldest first.
CREATE INDEX crm_drip_due_idx ON crm_drip_enrollments (next_due_at) WHERE state = 'active';
-- And "which drips is this person on", for the contact view and for opting out.
CREATE INDEX crm_drip_enrollment_contact_idx ON crm_drip_enrollments (contact_id);

-- The step rows, in the outbox that already exists.
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS drip_enrollment_id uuid
        REFERENCES crm_drip_enrollments(id) ON DELETE CASCADE;

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
    'wa_broadcast',
    -- One step of one person's sequence. Its own kind for the same reason
    -- 'wa_broadcast' is: the reminder kinds are rescheduled and skipped by name when
    -- a webinar moves, and a drip's third message is not a reminder about anything.
    'wa_drip'
));

-- Exactly the drip rows carry an enrollment, and exactly the broadcast rows carry a
-- broadcast. Stated, because the sweeps read "no drip_enrollment_id" as "not a drip".
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_drip_shape;
ALTER TABLE notifications ADD CONSTRAINT notifications_drip_shape CHECK (
    (kind = 'wa_drip') = (drip_enrollment_id IS NOT NULL)
);

/* Counting, and cancelling, one enrollment's messages.
 *
 * No unique index on (drip_enrollment_id, position) to match 0045's one-per-broadcast
 * rule, because a step is queued and the enrollment advanced in the same transaction:
 * the same step cannot be written twice without the position having moved, and a drip
 * that a host edits to repeat a template is allowed to send it again.
 */
CREATE INDEX notifications_drip_idx
    ON notifications (drip_enrollment_id, delivery)
    WHERE drip_enrollment_id IS NOT NULL;
