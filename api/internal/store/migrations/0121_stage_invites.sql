/* Stage invites waiting for an answer (api/internal/api/stage_invite.go).
 *
 * They used to live in the memory of whichever API instance the host's click reached,
 * while the attendee's "Join stage" goes to whichever instance answers it. With one
 * instance that is the same process. Once Cloud Run runs two or three — which a webinar
 * of 80 or more people is enough to cause — the accept usually found nothing, and the
 * attendee was told "That invite is no longer open."
 *
 * token identifies one invite, so the instance that set an invite's expiry timer removes
 * that invite and never a newer one for the same person. expires_at makes an invite
 * unusable on time even when its instance went away before the timer fired.
 *
 * Cascades with the webinar, like webinar_stage_grants: an invite outlives neither. */
CREATE TABLE webinar_stage_invites (
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    -- The LiveKit participant identity, as in webinar_stage_grants.
    identity    text NOT NULL,
    token       text NOT NULL,
    audio_only  boolean NOT NULL DEFAULT false,
    invited_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    PRIMARY KEY (webinar_id, identity)
);
