package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

/* AttendeeExportRow is one person in the attendee list export: a registrant, an
 * audience member who joined without a registration, or both joined up.
 *
 * Audience only ("att_" identities), the same split the report's headline figures and
 * the engagement scores use: the host and panelists are not attendees of their own
 * session. A registrant the host brought on stage keeps their att_ identity and is
 * listed, with JoinedVia "stage". */
type AttendeeExportRow struct {
	Name, Email, Phone string
	RegisteredAt       *time.Time
	Attended           bool
	FirstJoinedAt      *time.Time
	// Nil while a visit is still open, or for a no-show.
	LastLeftAt   *time.Time
	WatchSeconds int64
	// stage, webrtc, edge or zoom; empty for a no-show.
	JoinedVia     string
	Questions     int
	Chats         int
	PollsAnswered int
	RaisedHand    bool
	Answers       map[string]string
}

/* EachAttendeeExportRow streams the attendee list one row at a time, so a large session is
 * never built in memory. attendedOnly drops the registrants who never joined.
 *
 * Ordered attendees first by arrival, then no-shows by registration time.
 *
 * joined_via is derived from what the attendance tables already record: a Zoom venue's
 * stays all come from Zoom; a stage_on event means the person was brought on stage; a visit
 * the browser's beats owned (seen_at) is an edge viewer; anything else came over WebRTC.
 *
 * Raised hand reads both the computed engagement counts and the raw events, because raw
 * events are pruned after a while and the scores may not have been computed yet. */
func (s *Store) EachAttendeeExportRow(ctx context.Context, slug string, attendedOnly bool, fn func(AttendeeExportRow) error) error {
	if err := s.SweepEdgeVisits(ctx, slug, time.Now()); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, attendanceWindow+`,
	ppl AS (
	  SELECT a.identity, a.registration_id, a.name
	    FROM attendance a JOIN win ON win.id = a.webinar_id
	   WHERE starts_with(a.identity, 'att_')
	),
	vis AS (
	  SELECT v.identity,
	         min(v.joined_at) AS first_joined,
	         max(v.left_at) AS last_left,
	         bool_or(v.left_at IS NULL) AS still_in,
	         bool_or(v.seen_at IS NOT NULL) AS edge,
	         sum(`+clippedSeconds+`)::bigint AS secs
	    FROM attendance_visits v JOIN win ON win.id = v.webinar_id
	   WHERE starts_with(v.identity, 'att_')
	   GROUP BY v.identity
	),
	reg AS (
	  SELECT r.* FROM registrations r JOIN win ON win.id = r.webinar_id
	   WHERE r.state <> 'declined'
	)
	SELECT COALESCE(NULLIF(btrim(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')), ''),
	                NULLIF(btrim(p.name), ''), 'Guest'),
	       COALESCE(r.email, ''), COALESCE(r.phone, ''), r.created_at,
	       p.identity IS NOT NULL,
	       vis.first_joined,
	       CASE WHEN vis.still_in THEN NULL ELSE vis.last_left END,
	       COALESCE(vis.secs, 0),
	       CASE WHEN p.identity IS NULL THEN ''
	            WHEN (SELECT w2.venue FROM webinars w2 WHERE w2.id = win.id) IN ('zoom_meeting', 'zoom_webinar') THEN 'zoom'
	            WHEN EXISTS (SELECT 1 FROM engagement_events e
	                          WHERE e.webinar_id = win.id AND e.identity = p.identity
	                            AND e.kind = 'stage_on') THEN 'stage'
	            WHEN COALESCE(vis.edge, false) THEN 'edge'
	            ELSE 'webrtc' END,
	       CASE WHEN p.identity IS NULL THEN 0 ELSE
	         (SELECT count(*) FROM session_questions q
	           WHERE q.webinar_id = win.id AND q.identity = p.identity) END,
	       CASE WHEN p.identity IS NULL THEN 0 ELSE
	         (SELECT count(*) FROM chat_messages c
	           WHERE c.webinar_id = win.id AND c.sender_identity = p.identity
	             AND c.deleted_at IS NULL) END,
	       CASE WHEN p.identity IS NULL THEN 0 ELSE
	         (SELECT count(*) FROM poll_votes pv JOIN polls pl ON pl.id = pv.poll_id
	           WHERE pl.webinar_id = win.id AND pv.identity = p.identity) END,
	       p.identity IS NOT NULL AND (
	         COALESCE((SELECT (es.counts->>'hands')::int FROM engagement_scores es
	                    WHERE es.webinar_id = win.id AND es.identity = p.identity), 0) > 0
	         OR EXISTS (SELECT 1 FROM engagement_events e
	                     WHERE e.webinar_id = win.id AND e.identity = p.identity
	                       AND e.kind = 'hand_raise')),
	       COALESCE(r.answers, '{}'::jsonb)
	  FROM reg r
	  FULL JOIN ppl p ON p.registration_id = r.id
	  LEFT JOIN vis ON vis.identity = p.identity
	 CROSS JOIN win
	 WHERE NOT $2::boolean OR p.identity IS NOT NULL
	 ORDER BY p.identity IS NULL, vis.first_joined NULLS LAST, r.created_at, p.identity`,
		slug, attendedOnly)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			row     AttendeeExportRow
			answers []byte
		)
		if err := rows.Scan(&row.Name, &row.Email, &row.Phone, &row.RegisteredAt, &row.Attended,
			&row.FirstJoinedAt, &row.LastLeftAt, &row.WatchSeconds, &row.JoinedVia,
			&row.Questions, &row.Chats, &row.PollsAnswered, &row.RaisedHand,
			&answers); err != nil {
			return err
		}
		var raw map[string]any
		if err := json.Unmarshal(answers, &raw); err != nil {
			return err
		}
		row.Answers = make(map[string]string, len(raw))
		for k, v := range raw {
			if str, ok := v.(string); ok {
				row.Answers[k] = str
			} else if v != nil {
				row.Answers[k] = fmt.Sprint(v)
			}
		}
		if err := fn(row); err != nil {
			return err
		}
	}
	return rows.Err()
}
