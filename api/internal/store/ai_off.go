package store

import (
	"context"
	"time"
)

/* The AI-off windows of a session (session_ai_off_intervals, migration 0143).
 *
 * The room's AI switch pauses AI while live and the host can resume it. Each pause is one
 * window: opened when the switch goes off while live (or the session goes live with it off),
 * closed when it comes back on, or at ended_at when the session ends while paused. Anything
 * said, asked or chatted inside a window is left out of every AI input — the recap, chapters,
 * the past-answers harvest, the Q&A assistant, hot-lead reasons and follow-ups. Switching it
 * while the session is not live opens no window. */

// AIOffWindow is one pause. To is zero while it is still open.
type AIOffWindow struct {
	From, To time.Time
}

// AIOffWindows is a session's pauses, oldest first.
type AIOffWindows []AIOffWindow

// Contains reports whether t falls inside a pause (from inclusive, to exclusive).
func (ws AIOffWindows) Contains(t time.Time) bool {
	for _, w := range ws {
		if !t.Before(w.From) && (w.To.IsZero() || t.Before(w.To)) {
			return true
		}
	}
	return false
}

// ContainsMs is Contains for a Unix-millisecond time, as transcript segments carry it.
func (ws AIOffWindows) ContainsMs(ms int64) bool {
	return len(ws) > 0 && ws.Contains(time.UnixMilli(ms))
}

// Minutes is how long AI was paused, rounded up to the minute, with an open window counted
// to now. 0 when it never was.
func (ws AIOffWindows) Minutes(now time.Time) int {
	var d time.Duration
	for _, w := range ws {
		to := w.To
		if to.IsZero() {
			to = now
		}
		if to.After(w.From) {
			d += to.Sub(w.From)
		}
	}
	if d <= 0 {
		return 0
	}
	return int((d + time.Minute - 1) / time.Minute)
}

/* aiOffAtSQL is a SQL condition: the time expression ts, of the webinar whose id is the
 * expression webinarID, falls inside one of its AI-off windows. An open window of an ended
 * session counts up to ended_at. For the AI-only reads that filter in SQL. */
func aiOffAtSQL(webinarID, ts string) string {
	return `EXISTS (SELECT 1 FROM session_ai_off_intervals aio JOIN webinars aiw ON aiw.id = aio.webinar_id
	         WHERE aio.webinar_id = ` + webinarID + ` AND ` + ts + ` >= aio.off_at
	           AND (COALESCE(aio.on_at, aiw.ended_at) IS NULL OR ` + ts + ` < COALESCE(aio.on_at, aiw.ended_at)))`
}

// AIOffWindows is the webinar behind slug's pauses since its session started, oldest first.
func (s *Store) AIOffWindows(ctx context.Context, slug string) (AIOffWindows, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT i.off_at, COALESCE(i.on_at, w.ended_at)
		  FROM session_ai_off_intervals i JOIN webinars w ON w.id = i.webinar_id
		 WHERE w.slug = $1 AND (w.started_at IS NULL OR COALESCE(i.on_at, w.ended_at, now()) > w.started_at)
		 ORDER BY i.off_at, i.id`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out AIOffWindows
	for rows.Next() {
		var w AIOffWindow
		var to *time.Time
		if err := rows.Scan(&w.From, &to); err != nil {
			return nil, err
		}
		if to != nil {
			w.To = *to
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

/* The writes. Each runs after the statement that changed the session, keyed by slug, and does
 * nothing when it does not apply, so a caller need not check first. */

// openAIOffSQL opens a pause for a live session whose switch is off, unless one is open.
const openAIOffSQL = `
	INSERT INTO session_ai_off_intervals (webinar_id, off_at)
	SELECT id, now() FROM webinars WHERE slug = $1 AND status = 'live' AND NOT ai_enabled
	ON CONFLICT (webinar_id) WHERE on_at IS NULL DO NOTHING`

// resumeAIOffSQL closes the open pause of a live session whose switch is back on.
const resumeAIOffSQL = `
	UPDATE session_ai_off_intervals i SET on_at = GREATEST(i.off_at, now())
	  FROM webinars w
	 WHERE w.id = i.webinar_id AND w.slug = $1 AND w.status = 'live' AND w.ai_enabled AND i.on_at IS NULL`

// endAIOffSQL closes the open pause of a session that is no longer live, at its end.
const endAIOffSQL = `
	UPDATE session_ai_off_intervals i SET on_at = GREATEST(i.off_at, COALESCE(w.ended_at, now()))
	  FROM webinars w
	 WHERE w.id = i.webinar_id AND w.slug = $1 AND w.status <> 'live' AND i.on_at IS NULL`

// afterWentLive opens the pause of a session that has just gone live with AI off.
func (s *Store) afterWentLive(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, openAIOffSQL, slug)
	return err
}

// afterEnded closes the pause of a session that has just ended while AI was off.
func (s *Store) afterEnded(ctx context.Context, slug string) error {
	if _, err := s.pool.Exec(ctx, endAIOffSQL, slug); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE webinars SET ai_off_this_session = false WHERE slug = $1 AND ai_off_this_session`, slug)
	return err
}

/* AIOffItems is the ids of the questions and the chat messages of the webinar behind slug
 * sent while AI was paused, for the readers that share their query with a non-AI screen (the
 * recap reads the same questions and chat as the export). Both maps are empty, never nil. */
func (s *Store) AIOffItems(ctx context.Context, slug string) (questions, chat map[string]bool, err error) {
	questions, chat = map[string]bool{}, map[string]bool{}
	rows, err := s.pool.Query(ctx, `
		SELECT 'q', q.id::text FROM session_questions q JOIN webinars w ON w.id = q.webinar_id
		 WHERE w.slug = $1 AND `+aiOffAtSQL("q.webinar_id", "q.created_at")+`
		UNION ALL
		SELECT 'c', m.id FROM chat_messages m JOIN webinars w ON w.id = m.webinar_id
		 WHERE w.slug = $1 AND `+aiOffAtSQL("m.webinar_id", "m.created_at"), slug)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var kind, id string
		if err := rows.Scan(&kind, &id); err != nil {
			return nil, nil, err
		}
		if kind == "q" {
			questions[id] = true
		} else {
			chat[id] = true
		}
	}
	return questions, chat, rows.Err()
}
