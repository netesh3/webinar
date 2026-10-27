-- The language a session transcript was captioned in (a types.CaptionLanguages code: en-IN,
-- hi, multi, ...), so the recap and the other AI reads know what they are reading. NULL for
-- transcripts from before the per-webinar captions language (2026-10-27).
ALTER TABLE session_transcripts ADD COLUMN language text;
