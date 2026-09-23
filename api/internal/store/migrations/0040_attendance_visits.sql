-- One row per visit, because one row per person cannot answer the question.
--
-- attendance (migrations/0031) holds first_joined_at and last_seen_at per person, and the
-- report derived watch time as the difference between them. That is an ELAPSED SPAN, not
-- time present, and for anybody who rejoined it is simply wrong: somebody who watched
-- 10:00-10:05, went to another meeting, and came back for 10:55-11:00 was reported as
-- having watched 60 minutes of a 60-minute webinar. They watched ten.
--
-- It cannot be fixed in that shape. Two timestamps can describe one interval and a person
-- who leaves and comes back is two, so this is a second table rather than more columns.
CREATE TABLE attendance_visits (
    id         bigserial PRIMARY KEY,
    webinar_id uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    identity   text NOT NULL,
    joined_at  timestamptz NOT NULL,
    -- NULL means still in the room. Closed by participant_left, by room_finished, or by
    -- the host ending the webinar -- whichever reaches us first. See CloseOpenVisits for
    -- why more than one of those has to be able to do it.
    left_at    timestamptz
);

CREATE INDEX attendance_visits_webinar_idx
    ON attendance_visits (webinar_id, identity, joined_at);

/* At most one open visit per person per webinar, enforced rather than assumed.
 *
 * LiveKit refuses a second participant with the same identity in one room, so "already in
 * the room" is a real invariant of the source rather than a hope about it. Writing it down
 * buys two things: a re-delivered participant_joined webhook -- which LiveKit will do, since
 * it retries -- cannot open a duplicate visit, and CloseVisit never has to choose between
 * two candidate rows.
 *
 * Partial, so closed visits are unconstrained: rejoining is the entire point. */
CREATE UNIQUE INDEX attendance_visits_open_idx
    ON attendance_visits (webinar_id, identity)
 WHERE left_at IS NULL;

/* What the old shape can still tell us, seeded as one visit each.
 *
 * Exactly one, because one interval is all two timestamps could ever have described. So a
 * webinar from last month keeps the number it has always shown rather than going blank,
 * and any rejoin inside it stays invisible -- the events that would have revealed it were
 * never recorded. Sessions from here on are built from participant_joined and
 * participant_left and do not have that ceiling.
 */
INSERT INTO attendance_visits (webinar_id, identity, joined_at, left_at)
SELECT webinar_id, identity, first_joined_at, last_seen_at
  FROM attendance
 WHERE last_seen_at > first_joined_at;
