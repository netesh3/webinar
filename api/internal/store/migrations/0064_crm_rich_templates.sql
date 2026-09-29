/* Rich templates: an image header (the webinar's cover) and buttons.
 *
 * header_format is Meta's: TEXT, IMAGE, VIDEO, DOCUMENT, or '' for none. buttons is the
 * template's buttons as Meta approved them — type, text, url, and whether the url ends in
 * a variable the send fills with the person's own link. Cached like the rest of the row.
 */
ALTER TABLE crm_templates
    ADD COLUMN header_format text NOT NULL DEFAULT '',
    ADD COLUMN buttons jsonb NOT NULL DEFAULT '[]';

/* link_url is where a WhatsApp message's dynamic link button goes, resolved when the row
 * is queued: the person's own join link for a confirmation or reminder, the replay page
 * for a replay. Like the email body in the same table, which already carries the join
 * link, it is a credential for that one person. Empty means the webinar's page. */
ALTER TABLE notifications ADD COLUMN link_url text NOT NULL DEFAULT '';
