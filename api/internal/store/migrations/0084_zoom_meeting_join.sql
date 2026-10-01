/* The meeting's shared attendee link. Personal registrant links stay on
 * registrations.zoom_join_url. This column is not a public field and is not logged.
 */
ALTER TABLE webinars
    ADD COLUMN zoom_join_url text NOT NULL DEFAULT '';
