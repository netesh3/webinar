-- Tags and notes: the two things a host writes about a person rather than to them.
--
-- Everything in the CRM until now has been a message or the rule that sends one. These
-- are neither. A tag is a label the host puts on somebody and can then act on — send to
-- it, start a sequence when it is added, set it from a bot — and a note is a sentence
-- only the host ever reads. Both were in the plan from the start and both were held
-- back because three other things pointed at them: the broadcast audience, the
-- `tag_added` sequence trigger, and the bot step that sets one. They are wired up here.
--
-- Both are gated per account by the switches added in 0047 (`crm_tags`, `crm_notes`).
-- The tables exist for every host either way: a switch that is turned off has to be
-- turnable back on without losing what was written under it.

/* The labels themselves, one set per host.
 *
 * A name and nothing else. No colour, no group, no description — a tag earns its place
 * by being something this server can act on, and a colour changes nothing about who
 * gets messaged. Adding one later costs a column; adding one now costs every screen a
 * picker nobody asked for.
 */
CREATE TABLE crm_tags (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- The host's own words, trimmed and single-spaced by the API.
    name    text NOT NULL CHECK (name <> '' AND length(name) <= 48),

    created_at timestamptz NOT NULL DEFAULT now()
);

/* One label per name per host, case-insensitively.
 *
 * "VIP" and "vip" are one tag, because a host who typed the second meant the first —
 * and because two tags that read the same on screen make every audience and every
 * trigger a coin toss. The API answers a duplicate with the existing tag rather than an
 * error: asking for a label that is already there is not a mistake.
 */
CREATE UNIQUE INDEX crm_tags_host_name_key ON crm_tags (host_id, lower(name));
CREATE INDEX crm_tags_host_idx ON crm_tags (host_id, name);

/* Which contacts carry which label.
 *
 * A join table with a timestamp, and the timestamp is not decoration: `tag_added` is a
 * sequence trigger, so when a label went on somebody is part of the record of why they
 * are being messaged.
 *
 * No host_id column. Both sides already have one and they are the same host — the API
 * checks that before inserting, and a third copy would be a third thing to keep true.
 */
CREATE TABLE crm_contact_tags (
    contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    tag_id     uuid NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, tag_id)
);

-- "Who has this tag" — the audience query, and the count beside each tag.
CREATE INDEX crm_contact_tags_tag_idx ON crm_contact_tags (tag_id);

/* Notes: what the host knows about somebody that the CRM does not.
 *
 * Private to the account. Never sent, never merged into a template, never readable by
 * the person it is about — which is the whole point of the feature ("asked us to call
 * after 5", "already a customer") and the reason it is a table rather than a text field
 * on the contact.
 *
 * Immutable: there is no UPDATE path and no updated_at. A note is a dated observation,
 * and editing one rewrites what the host knew in February. Correcting one means
 * deleting it and writing another, which leaves both facts where they belong in time.
 */
CREATE TABLE crm_notes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,

    body       text NOT NULL CHECK (body <> '' AND length(body) <= 2000),

    /* Who wrote it. Always the host today, because the CRM is scoped to one account and
     * nobody else can reach it. Kept anyway, and SET NULL rather than CASCADE: when a
     * second person can read a host's CRM, "who wrote this" is the first thing a note
     * needs, and backfilling it then is impossible. */
    author_id  uuid REFERENCES users(id) ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now()
);

-- One contact's notes, newest first, which is the only query this table has.
CREATE INDEX crm_notes_contact_idx ON crm_notes (contact_id, created_at DESC);

/* The third audience a broadcast can have, which 0044 left out of its CHECK because
 * there were no tags to send to.
 *
 * Still a short list of sets this server resolves itself — see the comment on the
 * audience column — and a tag is the first one the host composes rather than the schema:
 * "everybody who opted in" and "one webinar's registrants" are facts we already had, and
 * "the people I marked as interested" is the host's own segment.
 */
ALTER TABLE crm_broadcasts DROP CONSTRAINT IF EXISTS crm_broadcasts_audience_check;
ALTER TABLE crm_broadcasts ADD CONSTRAINT crm_broadcasts_audience_check CHECK (audience IN
    ('opted_in','webinar','tag'));

/* Which tag was sent to. RESTRICT, matching crm_drips below: a broadcast is the record of
 * a message that was actually sent, and "sent to VIP" turning into "sent to everybody" —
 * which is what SET NULL would read as, since NULL is the shape of every other audience —
 * would rewrite history rather than lose a detail of it.
 */
ALTER TABLE crm_broadcasts
    ADD COLUMN IF NOT EXISTS tag_id uuid REFERENCES crm_tags(id) ON DELETE RESTRICT;

ALTER TABLE crm_broadcasts DROP CONSTRAINT IF EXISTS crm_broadcasts_needs_a_tag;
ALTER TABLE crm_broadcasts
    ADD CONSTRAINT crm_broadcasts_needs_a_tag
        CHECK (audience <> 'tag' OR tag_id IS NOT NULL);

/* The sequence trigger the plan asked for in 0045 and could not have: tag_added.
 *
 * It fires wherever a tag is applied — by the host from the inbox, or by a bot step —
 * and it is the first trigger that is not about a webinar. A sequence on it therefore
 * has no `topic` and no `when` to fill a template with, which is the same position the
 * manual trigger is already in.
 */
ALTER TABLE crm_drips DROP CONSTRAINT IF EXISTS crm_drips_trigger_kind_check;
ALTER TABLE crm_drips ADD CONSTRAINT crm_drips_trigger_kind_check CHECK (trigger_kind IN
    ('manual','registered','attended','no_show','ended','tag_added'));

/* Which tag starts it, or NULL for any tag.
 *
 * RESTRICT, unlike every other pointer at a deletable row in this schema, and the
 * wildcard is why. NULL here means "any tag", so SET NULL on a deleted tag would not
 * break the rule — it would silently widen it from one label to every label, and start
 * messaging people the host never meant to include. CASCADE would be worse: it would
 * delete a running sequence and everybody's place on it. So a tag that starts a
 * sequence cannot be deleted until the sequence stops naming it, and the API says so in
 * those words.
 */
ALTER TABLE crm_drips
    ADD COLUMN IF NOT EXISTS trigger_tag_id uuid REFERENCES crm_tags(id) ON DELETE RESTRICT;

/* The bot step that sets a tag, which 0046 left out for the same reason.
 *
 * It sends nothing, which makes it the only step the person on the other end cannot see
 * happening, and the only one whose cost is zero. That is exactly why it is worth
 * having: "they pressed the pricing button" is a fact about a lead, and a flow that can
 * record it turns a conversation into a segment.
 */
ALTER TABLE crm_bot_nodes DROP CONSTRAINT IF EXISTS crm_bot_nodes_kind_check;
ALTER TABLE crm_bot_nodes ADD CONSTRAINT crm_bot_nodes_kind_check CHECK (kind IN
    ('message','ask','wait','enroll','handoff','set_tag'));

-- Which tag a set_tag node applies. SET NULL, matching drip_id on the same table and
-- for the same reason: deleting a tag must not delete a step out of the middle of a
-- running flow. The node survives with nothing to apply, the runtime steps over it, and
-- the builder shows it as broken — which is the state the host is in.
ALTER TABLE crm_bot_nodes
    ADD COLUMN IF NOT EXISTS tag_id uuid REFERENCES crm_tags(id) ON DELETE SET NULL;

/* The replay link, on both channels.
 *
 * 0043 noted that a replay message had no trigger on any channel: nothing in this
 * application ever said "the recording is up, here it is". Sharing a recording is that
 * moment — the host has decided it may be watched — and it is the only one, which is
 * why these are queued from the share endpoint rather than from a sweep over finished
 * recordings the host has not looked at yet.
 */
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
    'wa_drip',
    -- The email with the link to watch it back.
    'replay_ready',
    -- The same sentence on WhatsApp, on a template the host has chosen for it.
    'wa_replay'
));

/* One replay message per registration per channel, for ever.
 *
 * The same rule the confirmation and the reminders have, and here it also decides
 * something else: a host who shares a second recording of the same webinar sends
 * nothing, because two "watch the replay" messages about one session read as a mistake
 * — and on WhatsApp the mistake is also on the host's bill. Un-sharing and re-sharing
 * likewise sends nothing, which is what stops a toggle from becoming a send button.
 */
DROP INDEX IF EXISTS notifications_one_per_kind_reg;
CREATE UNIQUE INDEX notifications_one_per_kind_reg
    ON notifications (kind, registration_id)
    WHERE registration_id IS NOT NULL
      AND kind IN (
          'registration_confirmed',
          'registration_approved',
          'reminder_24h',
          'reminder_1h',
          'replay_ready'
      );

DROP INDEX IF EXISTS notifications_one_wa_per_kind_reg;
CREATE UNIQUE INDEX notifications_one_wa_per_kind_reg
    ON notifications (kind, registration_id)
    WHERE registration_id IS NOT NULL
      AND kind IN ('wa_registration_confirmed','wa_reminder_24h','wa_reminder_1h','wa_replay');

/* And the kind a host can choose a template for.
 *
 * 0043 listed the three kinds that existed then. Without this the replay is a message
 * nobody can configure: the settings screen offers it, the host picks an approved
 * template, and the save fails on a constraint — the WhatsApp half of the feature would
 * be unreachable while every other part of it worked.
 */
ALTER TABLE crm_reminder_templates DROP CONSTRAINT IF EXISTS crm_reminder_templates_kind_check;
ALTER TABLE crm_reminder_templates ADD CONSTRAINT crm_reminder_templates_kind_check
    CHECK (kind IN (
        'wa_registration_confirmed',
        'wa_reminder_24h',
        'wa_reminder_1h',
        'wa_replay'
    ));
