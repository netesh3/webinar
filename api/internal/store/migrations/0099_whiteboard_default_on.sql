-- Whiteboard on by default, for every host — existing and new.
--
-- Every other switch is off until an administrator turns it on (migrations/0048),
-- because each of those spends the host's money or writes to somebody else's phone.
-- The whiteboard does neither: it is drawn in the browser and travels over the
-- session's own LiveKit room. So it starts on, and the switch is there to turn it
-- OFF for an account that should not have it.
--
-- Two halves:
--
--   1. Every account that exists now gets it. All accounts rather than only
--      can_host ones, so somebody made a host later is not the one host without it.
--   2. New accounts start with it, through the column default. Inserts into users
--      never name `features` (store.CreateUser, the guest-registration insert, the
--      seed), so the default is what every new row gets.
--
-- One shot, like every migration: an administrator who turns it off afterwards is
-- not switched back on at the next boot.

UPDATE users
   SET features = array_append(features, 'whiteboard')
 WHERE NOT ('whiteboard' = ANY (features));

ALTER TABLE users
    ALTER COLUMN features SET DEFAULT '{whiteboard}';
