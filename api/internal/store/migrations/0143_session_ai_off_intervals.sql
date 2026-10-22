-- The room's AI switch can be turned back on during a live session (decided 2026-10-22,
-- replacing 0133's latch). Each stretch of a live session with AI off is one row here:
-- opened by the controls PATCH turning AI off while live (or by going live with AI off),
-- closed by turning it back on, or at ended_at when the session ends while it is off.
-- Everything said, asked or chatted inside a window stays out of every AI input
-- (store.AIOffWindows). webinars.ai_off_this_session now means "AI is paused right now".
CREATE TABLE session_ai_off_intervals (
    id          bigserial PRIMARY KEY,
    webinar_id  uuid NOT NULL REFERENCES webinars(id) ON DELETE CASCADE,
    off_at      timestamptz NOT NULL,
    on_at       timestamptz,
    CHECK (on_at IS NULL OR on_at >= off_at)
);

CREATE INDEX session_ai_off_intervals_webinar ON session_ai_off_intervals (webinar_id, off_at);
-- At most one open window per session.
CREATE UNIQUE INDEX session_ai_off_intervals_open ON session_ai_off_intervals (webinar_id) WHERE on_at IS NULL;

-- A session live right now that 0133 latched: AI paused since the start, so a resume keeps
-- everything before it out of AI. The switch reads off until the host turns it back on.
INSERT INTO session_ai_off_intervals (webinar_id, off_at)
SELECT id, COALESCE(started_at, now()) FROM webinars
 WHERE status = 'live' AND ai_off_this_session;
UPDATE webinars SET ai_enabled = false WHERE status = 'live' AND ai_off_this_session;

-- An ended session the latch kept out of AI stays out (its switch reads off), as before.
UPDATE webinars SET ai_enabled = false, ai_off_this_session = false
 WHERE status = 'ended' AND ai_off_this_session;
UPDATE webinars SET ai_off_this_session = false
 WHERE status NOT IN ('live', 'ended') AND ai_off_this_session;
