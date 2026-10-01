-- What a WhatsApp message was, besides the text.
--
-- kind already records Meta's type (image, voice, document, unsupported, …)
-- and body is the caption, the button title, or the text. This column is the
-- rest: the media id the Cloud API uses to download the bytes, the mime type
-- and filename, a location, a reaction, contact names, and — for Meta's own
-- type "unsupported" — the error code and title Meta sent with it.
--
-- Older rows stay '{}'. The inbox labels those from kind and body, which is
-- all that was kept.

ALTER TABLE crm_messages
    ADD COLUMN media jsonb NOT NULL DEFAULT '{}'::jsonb;
