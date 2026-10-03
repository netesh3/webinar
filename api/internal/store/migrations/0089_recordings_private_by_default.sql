-- A new recording is private until the host publishes it.
--
-- 0024 added is_public with DEFAULT true, so anyone holding a recording's link could
-- watch and download the session as soon as its file landed — before the host had
-- looked at it, and with the share switch that is meant to publish it (and send the
-- replay to every registrant) already on. StartRecording now sets the flag itself;
-- this is the same rule for anything that inserts a row without naming the column.
--
-- Existing rows keep the value they have. Their links may already be in replay mails
-- and in students' inboxes, and switching them off here would break every one of them
-- without the host deciding to. Changing a default does not rewrite the table.

ALTER TABLE recordings ALTER COLUMN is_public SET DEFAULT false;
