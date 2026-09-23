-- The three arms of contactMatchesRegistration, given something to stand on.
--
-- That predicate (crm_broadcasts.go) is the one place this schema joins a registration
-- to a contact, and until now not one of its three arms could use an index:
--
--   * registration_id had none at all — 0042 declares the foreign key, and Postgres
--     does not index the referencing side of one;
--   * the email arm compared the raw column against an index built on lower(email),
--     which the planner cannot match;
--   * a digits-only phone comparison is an expression no btree on phone can answer.
--
-- So the only plan available was: for every registration, walk every contact of that
-- host and run two regexp_replace calls per pair. That costs nothing on a CRM with
-- forty people in it and is the reason the feature would have to be withdrawn from the
-- host with forty thousand — the wrong way round, since those are the hosts it is for.
--
-- Three readers benefit and only one of them is new: the CRM list scoped to a webinar
-- and the broadcast audience preview both run this match today.

/* Arm 1. Partial, because registration_id is NULL for every contact that arrived from
 * WhatsApp rather than a registration form, and those rows can never match this arm. */
CREATE INDEX crm_contacts_registration_idx
    ON crm_contacts (registration_id)
    WHERE registration_id IS NOT NULL;

/* Arm 3. An expression index, because the comparison IS the expression: a registration
 * keeps whatever was typed ("+27 84 555 6666") and a contact is normalised, so the
 * digits are the only common ground. regexp_replace is IMMUTABLE, which is the whole
 * reason this is indexable.
 *
 * Arm 2 needs no index here. It is fixed in the predicate instead — lower(c.email)
 * rather than the bare column — which makes the existing crm_contacts_host_email_key
 * usable as it stands. */
CREATE INDEX crm_contacts_host_phone_digits_idx
    ON crm_contacts (host_id, regexp_replace(phone, '[^0-9]', '', 'g'))
    WHERE phone <> '';

/* "Has this contact ever written in, and when."
 *
 * Three readers: the 24-hour service window (LastInboundAt), the replied / no-reply
 * split on the contacts list, and the last-reply column on a webinar's attendees.
 * crm_messages_thread_idx (contact_id, created_at) does not carry direction, so
 * answering any of them means scanning back over however many outbound messages sit on
 * top — which for a contact who has been broadcast to and never replied is the entire
 * thread. Those are the contacts asked about most.
 */
CREATE INDEX crm_messages_inbound_idx
    ON crm_messages (contact_id, created_at DESC)
    WHERE direction = 'in';

/* Statistics for an expression index do not exist until something collects them, and a
 * planner with no estimate for the digits-only column guesses. Cheap here and worth it:
 * these two tables are what the whole CRM reads. */
ANALYZE crm_contacts;
ANALYZE crm_messages;
