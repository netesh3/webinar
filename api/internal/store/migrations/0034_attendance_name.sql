-- The name a person joined under, kept on the attendance row itself.
--
-- The report derived it instead by joining registrations, and fell back to
-- a.identity when that join found nothing. An identity is "att_" + the join
-- key, so anyone whose row carried no registration_id -- which is every row the
-- host's roster poll writes -- appeared in "who attended" as a random string.
-- The name is known at join time and the SFU roster repeats it, so store it
-- rather than reconstructing it from a table the row may not point at.
ALTER TABLE attendance ADD COLUMN name text NOT NULL DEFAULT '';

-- Recover what the sessions already on record can still tell us. Anyone who
-- spoke in chat signed their messages, and that name is the same one they
-- joined under. Attendees who only watched stay blank and the report calls
-- them Guest, which is at least true.
UPDATE attendance a
   SET name = c.sender_name
  FROM (
        SELECT DISTINCT ON (webinar_id, sender_identity)
               webinar_id, sender_identity, sender_name
          FROM chat_messages
         WHERE trim(sender_name) <> ''
         ORDER BY webinar_id, sender_identity, seq
       ) c
 WHERE c.webinar_id = a.webinar_id
   AND c.sender_identity = a.identity
   AND a.name = '';
