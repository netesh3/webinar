/* The media library's space: the bytes of a host's crm_media_files rows (the stored
 * file, after an image is converted; thumbnails are not counted), up to a limit —
 * MEDIA_QUOTA_DEFAULT_MB, 10 by default, or this per-account override an admin sets.
 * NULL is the default.
 *
 * Inbound WhatsApp media copies, recordings, chat images and covers are not library
 * files and do not count. Lowering a limit deletes nothing: an account over it keeps
 * its files and uploads nothing more until it is back under. */
ALTER TABLE users ADD COLUMN media_quota_bytes bigint
    CHECK (media_quota_bytes IS NULL OR media_quota_bytes > 0);
