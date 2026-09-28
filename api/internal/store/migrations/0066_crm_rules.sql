/* Automations the host writes: "When … → …" rules.
 *
 * A rule is a sequence (crm_drips) — it already has steps with waits, an outbox, retries,
 * opt-out checks and "one run per person". What it lacked:
 *
 *   New triggers:
 *     poll_answer   someone chose an answer in a poll (matched by question and answer text,
 *                   so one rule covers the same poll in every webinar)
 *     button_tap    someone tapped a quick-reply button on a message
 *     keyword_in    someone sent a message containing a word
 *   The match is trigger_match: {question, answer} / {text} / {word}.
 *
 *   New step kinds on crm_drip_steps:
 *     message  send an approved template (what every step was)
 *     tag      put a tag on them          (tag_id)
 *     notify   email the host             (note)
 *
 * A "wait" is not a step of its own: it is delay_minutes on the next step, as it always was.
 * Tag and notify steps send nothing to the person, so they skip the opt-in check.
 */
ALTER TABLE crm_drips DROP CONSTRAINT IF EXISTS crm_drips_trigger_kind_check;
ALTER TABLE crm_drips ADD CONSTRAINT crm_drips_trigger_kind_check CHECK (trigger_kind IN
    ('manual','registered','attended','no_show','ended','tag_added',
     'poll_answer','button_tap','keyword_in'));

ALTER TABLE crm_drips ADD COLUMN trigger_match jsonb NOT NULL DEFAULT '{}';

ALTER TABLE crm_drip_steps
    ADD COLUMN kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','tag','notify')),
    ADD COLUMN tag_id uuid REFERENCES crm_tags(id) ON DELETE SET NULL,
    ADD COLUMN note text NOT NULL DEFAULT '';
