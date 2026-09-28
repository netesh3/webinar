-- Profile photo.
--
-- google_picture is the https URL Google put on the Supabase access token
-- (user_metadata.picture) at sign-in. The bytes stay on Google's CDN; this
-- column is only the address.
--
-- An uploaded replacement is stored in the row, the same way a webinar cover
-- is (migrations/0016). This deployment has no durable object store — Cloud
-- Run's disk does not survive a cold start — and a profile photo that 503s
-- because of that is not a profile photo. avatar_key is the opaque ?v=
-- cache-buster and the "an upload exists" sentinel. Empty means none, and the
-- Google URL is used, then initials.
ALTER TABLE users ADD COLUMN google_picture text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_key text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_mime text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_data bytea NOT NULL DEFAULT '';
