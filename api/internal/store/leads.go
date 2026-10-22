package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

/* What the hot-leads ranking reads about one session (api/internal/leads): who registered,
 * who was in the room and for how long, and what each of them did. One read-only snapshot.
 *
 * Watch time is the session report's arithmetic (WatchByRegistrationSQL): each visit
 * clipped to the live window, summed. The stage ("user_" identities: the host, panelists)
 * is never a lead. */

// LeadRow is one person in a session, counted.
type LeadRow struct {
	// Key is the registration id, else the room identity of somebody who never registered.
	Key            string
	RegistrationID string
	Identity       string
	Name           string
	Email          string
	Phone          string
	Joined         bool
	WatchSec       int
	Questions      int
	Upvotes        int
	Chats          int
	PollAnswers    int
	RaisedHand     bool
	OnStage        bool
	// QuestionTexts and ChatTexts are their own words, newest last, bounded.
	QuestionTexts []string
	ChatTexts     []string
}

// LeadTextsPerPerson bounds the question and chat lines read per person.
const LeadTextsPerPerson = 8

/* LeadRows reads everybody who registered for (not declined) or was in the room of the
 * webinar behind slug. */
func (s *Store) LeadRows(ctx context.Context, slug string) ([]LeadRow, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var webinarID string
	if err := tx.QueryRow(ctx, `SELECT id::text FROM webinars WHERE slug = $1`, slug).Scan(&webinarID); err != nil {
		if noRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	var out []LeadRow
	byKey := map[string]int{}
	byIdentity := map[string]int{}

	// Registrations first: everybody the host could follow up with.
	rows, err := tx.Query(ctx, `
		SELECT r.id::text, btrim(btrim(r.first_name) || ' ' || btrim(r.last_name)), r.email, r.phone
		  FROM registrations r WHERE r.webinar_id = $1 AND r.state <> 'declined'
		 ORDER BY r.created_at`, webinarID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var l LeadRow
		if err := rows.Scan(&l.RegistrationID, &l.Name, &l.Email, &l.Phone); err != nil {
			rows.Close()
			return nil, err
		}
		l.Key = l.RegistrationID
		byKey[l.Key] = len(out)
		out = append(out, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// The room: every audience identity, its registration (if any) and its clipped watch time.
	rows, err = tx.Query(ctx, `
		SELECT a.identity, COALESCE(a.registration_id::text, ''), COALESCE(NULLIF(btrim(a.name), ''), 'Guest'),
		       COALESCE((SELECT sum(GREATEST(0, EXTRACT(EPOCH FROM (
		           LEAST(COALESCE(v.left_at, COALESCE(w.ended_at, now())), COALESCE(w.ended_at, now()))
		           - GREATEST(v.joined_at, COALESCE(w.started_at, v.joined_at))))))
		          FROM attendance_visits v WHERE v.webinar_id = a.webinar_id AND v.identity = a.identity), 0)::int,
		       EXISTS (SELECT 1 FROM attendance_visits v WHERE v.webinar_id = a.webinar_id AND v.identity = a.identity)
		  FROM attendance a JOIN webinars w ON w.id = a.webinar_id
		 WHERE a.webinar_id = $1 AND starts_with(a.identity, 'att_')
		 ORDER BY a.identity`, webinarID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var identity, rid, name string
		var watch int
		var visited bool
		if err := rows.Scan(&identity, &rid, &name, &watch, &visited); err != nil {
			rows.Close()
			return nil, err
		}
		i, ok := byKey[rid]
		if rid == "" || !ok {
			// Somebody in the room with no (live) registration: a meeting guest, a shared link.
			i = len(out)
			out = append(out, LeadRow{Key: identity, Name: name})
			byKey[identity] = i
		}
		l := &out[i]
		if l.Identity == "" {
			l.Identity = identity
		}
		if l.Name == "" {
			l.Name = name
		}
		// A person can hold two identities (two devices): add them up.
		l.WatchSec += watch
		l.Joined = l.Joined || visited
		byIdentity[identity] = i
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	add := func(identity string, f func(l *LeadRow)) {
		if i, ok := byIdentity[identity]; ok {
			f(&out[i])
		}
	}

	// Questions: their own (not dismissed), with the upvotes each got, newest last.
	rows, err = tx.Query(ctx, `
		SELECT identity, body, upvotes FROM (
		  SELECT identity, body, upvotes, created_at,
		         row_number() OVER (PARTITION BY identity ORDER BY created_at DESC) AS n
		    FROM session_questions
		   WHERE webinar_id = $1 AND starts_with(identity, 'att_') AND NOT dismissed) q
		 WHERE n <= $2 ORDER BY identity, created_at`, webinarID, LeadTextsPerPerson)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var identity, body string
		var up int
		if err := rows.Scan(&identity, &body, &up); err != nil {
			rows.Close()
			return nil, err
		}
		add(identity, func(l *LeadRow) { l.QuestionTexts = append(l.QuestionTexts, body) })
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Their counts: questions, upvotes on them, chat messages, poll answers, hands, stage.
	rows, err = tx.Query(ctx, `
		SELECT identity, sum(questions)::int, sum(upvotes)::int, sum(chats)::int, sum(polls)::int,
		       bool_or(hand), bool_or(stage)
		  FROM (
		    SELECT identity, count(*) AS questions, COALESCE(sum(upvotes), 0) AS upvotes, 0 AS chats, 0 AS polls,
		           false AS hand, false AS stage
		      FROM session_questions WHERE webinar_id = $1 AND starts_with(identity, 'att_') AND NOT dismissed
		     GROUP BY identity
		    UNION ALL
		    SELECT sender_identity, 0, 0, count(*), 0, false, false
		      FROM chat_messages WHERE webinar_id = $1 AND deleted_at IS NULL AND starts_with(sender_identity, 'att_')
		     GROUP BY sender_identity
		    UNION ALL
		    SELECT pv.identity, 0, 0, 0, count(*), false, false
		      FROM poll_votes pv JOIN polls p ON p.id = pv.poll_id
		     WHERE p.webinar_id = $1 AND starts_with(pv.identity, 'att_')
		     GROUP BY pv.identity
		    UNION ALL
		    SELECT identity, 0, 0, 0, 0, bool_or(kind = 'hand_raise'), bool_or(kind = 'stage_on')
		      FROM engagement_events WHERE webinar_id = $1 AND kind IN ('hand_raise', 'stage_on')
		     GROUP BY identity
		  ) c GROUP BY identity`, webinarID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var identity string
		var q, up, chats, polls int
		var hand, stage bool
		if err := rows.Scan(&identity, &q, &up, &chats, &polls, &hand, &stage); err != nil {
			rows.Close()
			return nil, err
		}
		add(identity, func(l *LeadRow) {
			l.Questions += q
			l.Upvotes += up
			l.Chats += chats
			l.PollAnswers += polls
			l.RaisedHand = l.RaisedHand || hand
			l.OnStage = l.OnStage || stage
		})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Their chat, newest last: text messages to everyone, the latest few.
	rows, err = tx.Query(ctx, `
		SELECT sender_identity, content FROM (
		  SELECT sender_identity, content, seq,
		         row_number() OVER (PARTITION BY sender_identity ORDER BY seq DESC) AS n
		    FROM chat_messages
		   WHERE webinar_id = $1 AND deleted_at IS NULL AND starts_with(sender_identity, 'att_')
		     AND message_type = 'text' AND btrim(content) <> '') m
		 WHERE n <= $2 ORDER BY sender_identity, seq`, webinarID, LeadTextsPerPerson)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var identity, text string
		if err := rows.Scan(&identity, &text); err != nil {
			rows.Close()
			return nil, err
		}
		text = strings.TrimSpace(text)
		add(identity, func(l *LeadRow) { l.ChatTexts = append(l.ChatTexts, text) })
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
