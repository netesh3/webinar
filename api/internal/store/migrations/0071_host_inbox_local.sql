/* Per-host inbox local-part for Reply-To.
 *
 * NULL is the default and means "do not set Reply-To", which is today's behaviour:
 * replies follow From. From stays SMTP_FROM — the shared Gmail account, or a verified
 * "Send mail as" alias — and is never this address. A value is the local part of
 * local@webinarliv.com, used only as Reply-To. Set it only after that address can
 * actually receive. Uniqueness is among hosts who have one, so two hosts cannot share
 * a mailbox.
 */
ALTER TABLE users ADD COLUMN inbox_local text;

ALTER TABLE users ADD CONSTRAINT users_inbox_local_shape
    CHECK (inbox_local IS NULL OR inbox_local ~ '^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$');

CREATE UNIQUE INDEX users_inbox_local_key ON users (inbox_local) WHERE inbox_local IS NOT NULL;
