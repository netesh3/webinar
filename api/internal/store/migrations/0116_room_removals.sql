-- Who the host removed from a webinar's room, so a refresh or a reopened link
-- cannot put them straight back in.
--
-- Removing someone has always disconnected them and taken back a stage seat. It
-- never stopped the same join link working, and that stays true for a person who
-- deliberately comes back through the door: this table is read by the automatic
-- rejoin path only (the rejoin cookie, the rejoin check, and a join the client
-- marks as a rejoin). A removal counts for the run it happened in — one older than
-- the webinar's latest start is ignored, so running the webinar again starts clean.
CREATE TABLE room_removals (
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    -- The LiveKit identity: att_<JOINKEY> for the audience, user_<id> for a panelist.
    identity    text NOT NULL,
    removed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (webinar_id, identity)
);
