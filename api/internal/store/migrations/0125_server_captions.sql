-- Server-side live captions (deploy/captions): a LiveKit agent on the egress host transcribes
-- the active speakers and posts each line to /api/internal/captions.
--
-- server_captions is the host's request ("run the caption agent in this room"): the API has
-- created an agent dispatch for the room. server_captions_live is the agent's own report that
-- it has joined and is transcribing, set through /api/internal/captions/status. Browsers skip
-- their on-device Whisper only when BOTH are true (SessionControls.serverCaptions), so a
-- dispatch no worker picked up, or an agent paused by its CPU guard, falls back to the
-- speaker's own browser instead of leaving the room without captions.
ALTER TABLE webinars
    ADD COLUMN server_captions      boolean NOT NULL DEFAULT false,
    ADD COLUMN server_captions_live boolean NOT NULL DEFAULT false;

-- The after-session transcript: the agent's re-transcription of the speakers' audio with a
-- bigger model once the room has ended. One row per pass (a session restarted after ending
-- gets a second). segments is a JSON array of {identity, name, start, end, text}, start and
-- end in Unix milliseconds. Feeds the AI recap.
CREATE TABLE session_transcripts (
    id          bigserial PRIMARY KEY,
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    segments    jsonb NOT NULL,
    model       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_transcripts_webinar ON session_transcripts (webinar_id, created_at);
