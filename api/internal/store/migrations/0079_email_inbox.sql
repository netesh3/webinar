/* Host reply inbox.
 *
 * inbox_local (0071) is the current address. inbox_renamed_at is set only when
 * the host changes it themselves. The automatic default does not set it, so
 * that first assignment does not use up the one self-service change.
 * After that change the column stays set and further edits are refused.
 *
 * inbox_aliases keeps the previous local part so mail to the old address
 * still reaches the same host. One previous address, because there is only
 * one change.
 */
ALTER TABLE users DROP CONSTRAINT users_inbox_local_shape;
UPDATE users
   SET inbox_local = NULL
 WHERE inbox_local IS NOT NULL
   AND inbox_local !~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$';
ALTER TABLE users ADD CONSTRAINT users_inbox_local_shape
    CHECK (inbox_local IS NULL OR inbox_local ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$');

ALTER TABLE users ADD COLUMN inbox_renamed_at timestamptz;

CREATE TABLE inbox_aliases (
    local text PRIMARY KEY CHECK (local ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inbox_aliases_one_per_user ON inbox_aliases (user_id);

CREATE TABLE host_emails (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('in', 'out')),
    from_addr text NOT NULL,
    to_addr text NOT NULL,
    subject text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    message_id text NOT NULL DEFAULT '',
    in_reply_to text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX host_emails_user_created ON host_emails (user_id, created_at DESC);
