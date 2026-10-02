/* Hosts can change the reply address as often as they like.
 *
 * 0079 kept a single previous local part, because a host could rename once.
 * Every earlier address now stays in inbox_aliases, so mail to it still
 * arrives. The local-part check allows a hyphen anywhere; a host-chosen
 * name is still 3–30 characters in the API.
 */
ALTER TABLE users DROP CONSTRAINT users_inbox_local_shape;
ALTER TABLE users ADD CONSTRAINT users_inbox_local_shape
    CHECK (inbox_local IS NULL OR inbox_local ~ '^[a-z0-9-]{1,32}$');

ALTER TABLE inbox_aliases DROP CONSTRAINT inbox_aliases_local_check;
ALTER TABLE inbox_aliases ADD CONSTRAINT inbox_aliases_local_check
    CHECK (local ~ '^[a-z0-9-]{1,32}$');

DROP INDEX inbox_aliases_one_per_user;
