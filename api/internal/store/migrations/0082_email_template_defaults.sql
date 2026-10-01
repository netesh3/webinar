/* Default email templates: the wordings the product already sends for a host.
 *
 * template_key identifies a required message. Empty means the host wrote it
 * themselves and may delete it. customized is set when they edit a required
 * row; revert clears it and puts the product subject and body back.
 * A required row cannot be deleted.
 */
ALTER TABLE email_templates
    ADD COLUMN template_key text NOT NULL DEFAULT '',
    ADD COLUMN customized boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX email_templates_one_key_per_host
    ON email_templates (user_id, template_key)
    WHERE template_key <> '';
