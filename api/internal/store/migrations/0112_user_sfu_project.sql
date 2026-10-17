/* Which LiveKit project a host's NEW webinars go to.
 *
 * NULL is the default priority order from LIVEKIT_PROJECTS (first enabled project). A value
 * names a project id; it is used for a webinar's first pin only when that project is still
 * configured and enabled, so retiring or removing a project quietly sends the host's new
 * webinars back to the default order. A webinar already pinned (webinars.sfu_project) never
 * moves because of this column. Set by an admin: PATCH /api/admin/users/{id}/sfu.
 */
ALTER TABLE users ADD COLUMN sfu_project text;
