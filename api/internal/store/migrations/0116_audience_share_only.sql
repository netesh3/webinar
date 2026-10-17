/* "Audience sees only the shared video."
 *
 * A host playing an older recording into a live webinar wants the audience to see
 * that video and nothing else: no current cameras, names or stage labels. Two
 * session controls, mirrored into room metadata like the others:
 *
 *   audience_share_only  attendees render only the active share, full-bleed, and
 *                        stop subscribing to stage cameras. With no share active
 *                        they see the normal stage, so it never shows a blank room.
 *   audience_mute_stage  attendees also stop hearing stage microphones; the share's
 *                        own audio still plays. Turned on with the first by default.
 *
 * Live-only: cleared when the webinar ends or goes back to scheduled/draft
 * (store.SetStatus), and never set by the schedule form or a copy.
 */
ALTER TABLE webinars
    ADD COLUMN audience_share_only boolean NOT NULL DEFAULT false,
    ADD COLUMN audience_mute_stage boolean NOT NULL DEFAULT false;
