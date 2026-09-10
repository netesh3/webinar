-- Where attendee chat goes: to the whole room, or to the stage only.
--
-- A session control rather than a per-message choice by the sender, because the
-- host owns it and an attendee must not be able to override it. It lives here, in
-- the same row as the other controls, so it survives an API restart and applies to
-- somebody who joins ten minutes after it was set — the same reason hide_attendees
-- is a column and not a variable in a process.
--
-- 'everyone' by default: a webinar that silently routes the audience's first
-- messages away from the audience would be a surprise, and the restrictive setting
-- is the one worth requiring a decision.
ALTER TABLE webinars
    ADD COLUMN chat_destination text NOT NULL DEFAULT 'everyone'
        CHECK (chat_destination IN ('everyone', 'panelists'));
