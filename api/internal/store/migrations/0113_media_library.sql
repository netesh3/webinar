/* The host's media library: every file uploaded for WhatsApp templates (0110) is
 * listed back in a gallery to pick from again.
 *
 * thumb_key is a small JPEG next to an image (storage_key + '.thumb.jpg'), so the
 * gallery grid does not pull full pictures. Empty for videos and documents, and for
 * images uploaded before this migration until the gallery lists them once (it makes
 * the thumbnail then). width/height are the stored image's pixels, 0 when unknown;
 * the gallery uses them to say an image is the wrong shape for a carousel card.
 *
 * Library files live under wa/<host>/files/, which no retention sweep deletes: they
 * are the coach's own uploads and stay until the coach deletes them (or the account
 * goes). */
ALTER TABLE crm_media_files
    ADD COLUMN thumb_key text NOT NULL DEFAULT '',
    ADD COLUMN width integer NOT NULL DEFAULT 0,
    ADD COLUMN height integer NOT NULL DEFAULT 0;
