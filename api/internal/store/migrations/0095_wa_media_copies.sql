/* Our own copy of WhatsApp attachments.
 *
 * crm_messages.media (0077) keeps Meta's media id, and every view fetched the file
 * from Graph. Meta only keeps inbound media for a limited time, so older images
 * broke for good, and any Graph or token failure showed as a bare "Photo".
 *
 * The CRM tick now downloads each attachment soon after it arrives and stores it
 * under media key wa/<host>/<message>; the media endpoint serves that copy and
 * falls back to Graph only while no copy exists. A copy is deleted 90 days after it
 * was stored (expired_at is then set, and the endpoint answers 410).
 *
 * One row per message that has been tried at all: storage_key '' with attempts > 0
 * is a download still being retried; expired_at with no key is gone for good. The
 * row cascades with its message. Files are keyed by host, so removing an account
 * can drop the whole wa/<host>/ prefix.
 */
CREATE TABLE crm_message_media (
    message_id  uuid PRIMARY KEY REFERENCES crm_messages (id) ON DELETE CASCADE,
    host_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    storage_key text NOT NULL DEFAULT '',
    mime        text NOT NULL DEFAULT '',
    bytes       bigint NOT NULL DEFAULT 0,
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text NOT NULL DEFAULT '',
    stored_at   timestamptz,
    expired_at  timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_message_media_stored ON crm_message_media (stored_at)
    WHERE storage_key <> '';

-- The tick looks for recent messages with a media id and no finished copy.
CREATE INDEX crm_messages_with_media ON crm_messages (created_at)
    WHERE media ? 'id';
