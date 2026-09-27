package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/netkumar/webcast/api/internal/engagement"
)

// EngagementWebinar is what the engagement service needs to know about a webinar before
// deciding whether a stored snapshot is still good.
type EngagementWebinar struct {
	ID        string
	Slug      string
	HostID    string
	Status    string
	StartedAt *time.Time
	EndedAt   *time.Time
}

func (s *Store) EngagementWebinar(ctx context.Context, slug string) (EngagementWebinar, error) {
	var w EngagementWebinar
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, slug, host_id::text, status, started_at, ended_at
		  FROM webinars WHERE slug = $1`, slug).
		Scan(&w.ID, &w.Slug, &w.HostID, &w.Status, &w.StartedAt, &w.EndedAt)
	if noRows(err) {
		return w, ErrNotFound
	}
	return w, err
}

/* EngagementInput loads everything one compute reads, for one webinar, in a single
 * round trip: the queries go as one pipelined batch inside a read-only repeatable-read
 * transaction, so every source is read from the same snapshot of the database.
 *
 * Each query is bounded by webinar_id and served by an existing (webinar_id, …) index.
 * Captured events are grouped per person, kind, value and minute in SQL, which is what
 * keeps 100k reactions from crossing the wire one row at a time. Chat bodies are reduced
 * to a length and a hash for scoring; only the latest few are read as text.
 */
func (s *Store) EngagementInput(ctx context.Context, webinarID string, now time.Time) (engagement.Input, error) {
	in := engagement.Input{Now: now}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return in, err
	}
	defer tx.Rollback(ctx)

	b := &pgx.Batch{}
	b.Queue(`
		SELECT w.slug, w.topic, u.name, w.time_zone, w.status, w.started_at, w.ended_at,
		       (SELECT count(*) FROM registrations r WHERE r.webinar_id = w.id AND r.state <> 'declined')
		  FROM webinars w JOIN users u ON u.id = w.host_id WHERE w.id = $1`, webinarID).
		QueryRow(func(row pgx.Row) error {
			w := &in.Webinar
			return row.Scan(&w.Slug, &w.Title, &w.HostName, &w.TimeZone, &w.Status,
				&w.StartedAt, &w.EndedAt, &in.Registered)
		})

	b.Queue(`
		SELECT a.identity,
		       COALESCE(NULLIF(btrim(COALESCE(r.first_name,'') || ' ' || COALESCE(r.last_name,'')), ''),
		                NULLIF(btrim(a.name), ''), 'Guest'),
		       COALESCE(r.email, ''), COALESCE(a.registration_id::text, '')
		  FROM attendance a LEFT JOIN registrations r ON r.id = a.registration_id
		 WHERE a.webinar_id = $1 AND starts_with(a.identity, 'att_')`, webinarID).
		Query(scanAll(&in.People, func(rows pgx.Rows, p *engagement.Person) error {
			return rows.Scan(&p.Identity, &p.Name, &p.Email, &p.RegistrationID)
		}))

	b.Queue(`
		SELECT identity, joined_at, left_at FROM attendance_visits
		 WHERE webinar_id = $1 AND starts_with(identity, 'att_')
		 ORDER BY identity, joined_at`, webinarID).
		Query(scanAll(&in.Visits, func(rows pgx.Rows, v *engagement.Visit) error {
			return rows.Scan(&v.Identity, &v.Joined, &v.Left)
		}))

	b.Queue(`
		SELECT sender_identity, created_at, char_length(content), hashtextextended(content, 0)
		  FROM chat_messages
		 WHERE webinar_id = $1 AND deleted_at IS NULL AND sender_role = 'attendee'
		 ORDER BY sender_identity, seq`, webinarID).
		Query(scanAll(&in.Chats, func(rows pgx.Rows, c *engagement.Chat) error {
			return rows.Scan(&c.Identity, &c.At, &c.Length, &c.Hash)
		}))

	b.Queue(`
		SELECT sender_name, created_at, CASE WHEN message_type = 'image' THEN '[image]' ELSE left(content, 280) END
		  FROM chat_messages
		 WHERE webinar_id = $1 AND deleted_at IS NULL AND sender_role = 'attendee'
		 ORDER BY seq DESC LIMIT 5`, webinarID).
		Query(scanAll(&in.LatestChat, func(rows pgx.Rows, c *engagement.ChatLine) error {
			return rows.Scan(&c.Name, &c.At, &c.Text)
		}))

	b.Queue(`
		SELECT id, identity, name, body, created_at, anonymous, dismissed, answered, upvotes
		  FROM session_questions WHERE webinar_id = $1 AND role = 'attendee'`, webinarID).
		Query(scanAll(&in.Questions, func(rows pgx.Rows, q *engagement.Question) error {
			return rows.Scan(&q.ID, &q.Identity, &q.Name, &q.Text, &q.At, &q.Anonymous,
				&q.Dismissed, &q.Answered, &q.Upvotes)
		}))

	b.Queue(`
		SELECT v.identity, v.created_at FROM session_question_votes v
		  JOIN session_questions q ON q.id = v.question_id
		 WHERE q.webinar_id = $1`, webinarID).
		Query(scanAll(&in.Upvotes, func(rows pgx.Rows, u *engagement.Upvote) error {
			return rows.Scan(&u.Identity, &u.At)
		}))

	b.Queue(`
		SELECT id::text, kind, question, options, correct_option, opened_at, closed_at
		  FROM polls WHERE webinar_id = $1 AND opened_at IS NOT NULL
		 ORDER BY opened_at`, webinarID).
		Query(scanAll(&in.Polls, func(rows pgx.Rows, p *engagement.Poll) error {
			var options []byte
			if err := rows.Scan(&p.ID, &p.Kind, &p.Question, &options, &p.Correct, &p.OpenedAt, &p.ClosedAt); err != nil {
				return err
			}
			return json.Unmarshal(options, &p.Options)
		}))

	b.Queue(`
		SELECT pv.poll_id::text, pv.identity, pv.choice, pv.voted_at
		  FROM poll_votes pv JOIN polls p ON p.id = pv.poll_id
		 WHERE p.webinar_id = $1`, webinarID).
		Query(scanAll(&in.Votes, func(rows pgx.Rows, v *engagement.Vote) error {
			return rows.Scan(&v.PollID, &v.Identity, &v.Choice, &v.At)
		}))

	b.Queue(`
		SELECT e.identity, e.kind, COALESCE(e.payload->>'emoji', ''),
		       floor(EXTRACT(EPOCH FROM (e.occurred_at - w.started_at)) / 60)::int AS minute,
		       count(*)::int
		  FROM engagement_events e JOIN webinars w ON w.id = e.webinar_id
		 WHERE e.webinar_id = $1 AND e.kind IN ('reaction', 'hand_raise') AND w.started_at IS NOT NULL
		 GROUP BY 1, 2, 3, 4`, webinarID).
		Query(scanAll(&in.Events, func(rows pgx.Rows, e *engagement.EventCount) error {
			return rows.Scan(&e.Identity, &e.Kind, &e.Value, &e.Minute, &e.Count)
		}))

	if err := tx.SendBatch(ctx, b).Close(); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return in, ErrNotFound
		}
		return in, err
	}
	return in, tx.Commit(ctx)
}

// scanAll collects every row of a batched query into dst.
func scanAll[T any](dst *[]T, scan func(pgx.Rows, *T) error) func(pgx.Rows) error {
	return func(rows pgx.Rows) error {
		out := []T{}
		for rows.Next() {
			var v T
			if err := scan(rows, &v); err != nil {
				return err
			}
			out = append(out, v)
		}
		*dst = out
		return rows.Err()
	}
}
