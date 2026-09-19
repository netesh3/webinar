CREATE TABLE session_captions (
  id          bigserial PRIMARY KEY,
  webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
  identity    text NOT NULL,
  body        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_captions_webinar_at ON session_captions (webinar_id, at);
