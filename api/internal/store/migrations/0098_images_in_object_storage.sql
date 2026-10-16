/* Cover images and profile photos move out of Postgres.
 *
 * 0016 and 0071 put the bytes in bytea because the deployment then had no
 * persistent object store. It has one now (media.Store, disk or S3), and images
 * in the main database bloat it and every backup. When that store is configured,
 * uploads go there and the row keeps only the key; image_key / avatar_key stay
 * the opaque ?v= cache-buster they always were.
 *
 * Existing bytea rows are moved by a leased tick job (api/images.go), not here:
 * SQL cannot write files. The job only clears image_data / avatar_data once the
 * file is finalized, and serving falls back to the bytes until then. The bytea
 * columns are dropped in a later migration, after the backfill has run.
 */
ALTER TABLE webinars ADD COLUMN image_storage_key text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_storage_key text NOT NULL DEFAULT '';

-- What the backfill still has to move; empty once it is done.
CREATE INDEX webinars_image_to_move ON webinars (id)
    WHERE image_key <> '' AND image_storage_key = '' AND octet_length(image_data) > 0;
CREATE INDEX users_avatar_to_move ON users (id)
    WHERE avatar_key <> '' AND avatar_storage_key = '' AND octet_length(avatar_data) > 0;
