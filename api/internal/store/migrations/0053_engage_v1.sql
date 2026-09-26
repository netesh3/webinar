-- Engage v1: follow-up after a webinar, the one inbox, and replies from the coach's phone.
-- See docs/engage/V1.md.

/* Two more broadcast audiences.
 *
 * `segment` is one webinar's registrants narrowed by what they did: attended or not, how
 * long they watched, whether they replied. The rule lives in `segment` so the broadcast
 * reads back as "watched 45+ min" rather than as a list of people.
 *
 * `contacts` is people the host ticked by hand. The list itself is not stored here: the
 * recipients are the queued rows in `notifications`, frozen when the broadcast is made,
 * exactly as for every other audience.
 */
ALTER TABLE crm_broadcasts DROP CONSTRAINT IF EXISTS crm_broadcasts_audience_check;
ALTER TABLE crm_broadcasts ADD CONSTRAINT crm_broadcasts_audience_check CHECK (audience IN
    ('opted_in','webinar','tag','segment','contacts'));

ALTER TABLE crm_broadcasts ADD COLUMN IF NOT EXISTS segment jsonb;

ALTER TABLE crm_broadcasts DROP CONSTRAINT IF EXISTS crm_broadcasts_segment_shape;
ALTER TABLE crm_broadcasts ADD CONSTRAINT crm_broadcasts_segment_shape CHECK (
    audience <> 'segment' OR (segment IS NOT NULL AND webinar_id IS NOT NULL)
);

-- The ended webinar's Messages tab lists what was sent about it.
CREATE INDEX IF NOT EXISTS crm_broadcasts_webinar_idx
    ON crm_broadcasts (webinar_id, created_at DESC) WHERE webinar_id IS NOT NULL;

/* Which queued message a conversation row came from, and which webinar it was about.
 *
 * notification_id is how a webinar's automatic messages (confirmation, each reminder,
 * replay) get delivered and read counts: those arrive by webhook against the message,
 * after the outbox row is done. webinar_id is the thread's day marker ("8 Sep · Scale
 * your coaching practice") and the per-webinar filter.
 *
 * `manual` is a message a person wrote — from the inbox, or from the WhatsApp Business app
 * on their phone (an echo). Only those answer somebody; a reminder that happens to go out
 * after a question does not.
 */
ALTER TABLE crm_messages
    ADD COLUMN IF NOT EXISTS notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS webinar_id uuid REFERENCES webinars(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS crm_messages_notification_idx
    ON crm_messages (notification_id) WHERE notification_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_messages_webinar_idx
    ON crm_messages (webinar_id) WHERE webinar_id IS NOT NULL;
-- "When did the host last answer this person": the needs-reply test, per contact.
CREATE INDEX IF NOT EXISTS crm_messages_manual_idx
    ON crm_messages (contact_id, created_at DESC) WHERE direction = 'out' AND manual;

/* Mark done. A conversation needs a reply while its newest inbound message is later than
 * both the host's last reply and this. A new message after it reopens the thread by
 * itself, so nothing has to clear it. */
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS inbox_done_at timestamptz;

/* Coexistence: the number stays on the WhatsApp Business app, and the Cloud API sends
 * alongside it. Such a number is not registered with a PIN (the app owns it) and its
 * phone-typed replies arrive as smb_message_echoes.
 *
 * whatsapp_reply_digest_at is when the host was last emailed about replies waiting, so
 * the email goes at most once per quiet spell rather than per message.
 */
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS whatsapp_coexistence boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS whatsapp_reply_digest_at timestamptz;
