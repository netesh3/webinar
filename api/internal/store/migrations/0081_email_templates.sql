/* Email templates: wordings a host keeps for mail the app sends on their behalf.
 *
 * Unlike WhatsApp, these are not submitted to Meta. They belong to one host.
 * The send schedule does not read this table yet; the library is list, create,
 * and edit until a schedule points at a row.
 */
CREATE TABLE email_templates (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL,
    subject    text NOT NULL,
    body       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT email_templates_name_len CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT email_templates_subject_len CHECK (char_length(subject) BETWEEN 1 AND 200),
    CONSTRAINT email_templates_body_len CHECK (char_length(body) BETWEEN 1 AND 8000)
);

CREATE UNIQUE INDEX email_templates_one_name_per_host
    ON email_templates (user_id, lower(name));

CREATE INDEX email_templates_user_updated
    ON email_templates (user_id, updated_at DESC);
