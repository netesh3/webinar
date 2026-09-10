-- Guest entry: a name, no email, straight into the room.
--
-- The shared link now offers two doors. "Register & Join" is the existing one and captures a
-- lead. "Join as Guest" asks for a name and nothing else, because the friction of a form is
-- what stops somebody watching a session a colleague just sent them a link to.
--
-- A guest is still a REGISTRATION, not a new kind of thing. Every gate in the join path already
-- reads a registration — approval state, the attendee ceiling, a stage grant that survives a
-- reconnect, chat attribution — and a parallel guests table would mean each of those growing a
-- second branch that has to be kept in step. The differences are two columns.
ALTER TABLE registrations ADD COLUMN is_guest boolean NOT NULL DEFAULT false;

-- Email becomes optional, for guests only.
--
-- It stays NOT NULL: an empty string is the right shape for "not collected" here, because it
-- matches how company, job_title and country already model absence in this table, and it means
-- no reader has to learn that this one column can be NULL.
--
-- The unique index is the part that has to change. `(webinar_id, lower(email))` is what makes
-- registering twice idempotent, and with an empty email it would let exactly ONE guest into any
-- webinar — the second would collide with the first and be handed the first guest's join key,
-- which is somebody else's seat and somebody else's chat identity.
--
-- So it becomes partial. Registrations with an email keep the one-per-address guarantee that the
-- idempotent re-register depends on; guests are exempt, because there is no address to be
-- unique on and each tap is a different person.
DROP INDEX registrations_webinar_email_key;
CREATE UNIQUE INDEX registrations_webinar_email_key
    ON registrations (webinar_id, lower(email))
 WHERE NOT is_guest;

-- Guests are the rows a host most often wants to tell apart — they have no email to follow up
-- on — so the registrant list filters on this.
CREATE INDEX registrations_guest_idx ON registrations (webinar_id) WHERE is_guest;
