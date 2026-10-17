/* Indexes for the foreign keys a webinar delete walks.
 *
 * Deleting a webinar cascades into its registrations and recordings, and Postgres
 * then has to find every row pointing at each of those to apply ON DELETE. Where the
 * referencing column has no index that is a scan of the whole table per deleted row:
 * a webinar with 300 registrants scanned attendance and survey_responses 300 times
 * each. These are the referencing columns on that path that had no index leading
 * with them. Partial, because most rows leave them NULL.
 *
 * Plain CREATE INDEX: migrations run in a transaction, and the tables are small
 * enough today that the build is brief.
 */
CREATE INDEX attendance_registration_idx ON attendance (registration_id)
    WHERE registration_id IS NOT NULL;
CREATE INDEX survey_responses_registration_idx ON survey_responses (registration_id)
    WHERE registration_id IS NOT NULL;
CREATE INDEX webinars_simulive_recording_idx ON webinars (simulive_recording_id)
    WHERE simulive_recording_id IS NOT NULL;
CREATE INDEX crm_drips_webinar_idx ON crm_drips (webinar_id)
    WHERE webinar_id IS NOT NULL;
CREATE INDEX crm_drip_enrollments_webinar_idx ON crm_drip_enrollments (webinar_id)
    WHERE webinar_id IS NOT NULL;
CREATE INDEX crm_contact_engagement_last_webinar_idx ON crm_contact_engagement (last_webinar_id)
    WHERE last_webinar_id IS NOT NULL;
CREATE INDEX crm_bot_nodes_drip_idx ON crm_bot_nodes (drip_id)
    WHERE drip_id IS NOT NULL;
