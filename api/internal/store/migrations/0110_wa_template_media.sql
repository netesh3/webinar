/* Files a host attaches to WhatsApp templates: the image, video or document in a
 * template's header.
 *
 * crm_media_files is the file itself, stored in the media store under
 * wa/<host>/files/<id> (so deleting the account's wa/<host>/ prefix removes it).
 * public_token is an unguessable path segment: Meta fetches a header by link at send
 * time and cannot present a session, so /api/wa/files/<token> serves the file to
 * anyone who has the token and to nobody who does not.
 *
 * crm_template_media is a template's default header file. Kept apart from
 * crm_templates because that table is a cache replaced from Meta on every sync, and
 * the file is ours, not Meta's. Keyed by the template's identity (host, name,
 * language) rather than a row id for the same reason.
 *
 * crm_broadcast_header is one broadcast's choice for a media header: a different file
 * for this send, or the webinar cover for an image header. No row means the
 * template's default.
 */
CREATE TABLE crm_media_files (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    storage_key  text NOT NULL,
    mime         text NOT NULL,
    filename     text NOT NULL DEFAULT '',
    bytes        bigint NOT NULL,
    public_token text NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_media_files_host ON crm_media_files (host_id, created_at DESC);

CREATE TABLE crm_template_media (
    host_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL,
    language   text NOT NULL,
    file_id    uuid NOT NULL REFERENCES crm_media_files (id) ON DELETE CASCADE,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (host_id, name, language)
);

CREATE TABLE crm_broadcast_header (
    broadcast_id uuid PRIMARY KEY REFERENCES crm_broadcasts (id) ON DELETE CASCADE,
    file_id      uuid REFERENCES crm_media_files (id) ON DELETE SET NULL,
    use_cover    boolean NOT NULL DEFAULT false
);
