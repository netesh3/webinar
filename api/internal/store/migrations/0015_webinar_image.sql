-- The webinar's own cover image, shown on the browse page and the registration page.
--
-- Stored as a key into the same object store the recordings and chat images use (see
-- internal/media), not as bytes in this table and not as a bucket URL: the served URL
-- always points back at this API, which is what lets the backend move where the bytes
-- actually live without ever changing a link a host has already shared. Empty means "no
-- image", matching the empty-string-sentinel convention already used for sfu_project
-- rather than NULL, so every read scans the same non-nullable column.
--
-- image_mime travels alongside the key because the serving handler needs a Content-Type
-- and re-deriving it by sniffing the stored bytes on every request would be wasted work
-- for something already known at upload time.
ALTER TABLE webinars ADD COLUMN image_key text NOT NULL DEFAULT '';
ALTER TABLE webinars ADD COLUMN image_mime text NOT NULL DEFAULT '';
