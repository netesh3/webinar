-- The account that knocked on a meeting's door, when the visitor was signed in.
--
-- A meeting guest is "att_<joinKey>" like any attendee, and a co-host's tools are REST calls
-- authorized by an account (store.IsCoHost), so making a guest co-host needs to know whose
-- account knocked. Deliberately NOT registrations.user_id: that makes a registration the
-- account's everywhere (the Attending list, joining by session with no key, the admin's
-- counts), and a knock is only "this account asked to come in". Read for co-host only.
--
-- ON DELETE SET NULL, as user_id: deleting an account must not drop the host's records.
ALTER TABLE registrations
    ADD COLUMN knock_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
