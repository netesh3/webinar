package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/netkumar/webcast/api/internal/engagement"
	"github.com/netkumar/webcast/api/internal/engagement/capture"
)

var eventColumns = []string{"webinar_id", "identity", "kind", "payload", "occurred_at"}

var emptyPayload = []byte(`{}`)

// InsertEngagementEvents writes one batch with COPY. It is the capture.Sink. Events carry
// the webinar's slug, which the realtime path already has; the ids are resolved here, once
// per batch, so capturing costs the relay no database read.
func (s *Store) InsertEngagementEvents(ctx context.Context, batch []capture.Event) error {
	slugs := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, e := range batch {
		if !seen[e.Slug] {
			seen[e.Slug] = true
			slugs = append(slugs, e.Slug)
		}
	}
	ids := make(map[string]pgtype.UUID, len(slugs))
	found, err := s.pool.Query(ctx, `SELECT slug, id FROM webinars WHERE slug = ANY($1)`, slugs)
	if err != nil {
		return err
	}
	for found.Next() {
		var (
			slug string
			id   pgtype.UUID
		)
		if err := found.Scan(&slug, &id); err != nil {
			found.Close()
			return err
		}
		ids[slug] = id
	}
	found.Close()
	if err := found.Err(); err != nil {
		return err
	}

	rows := make([][]any, 0, len(batch))
	for _, e := range batch {
		wid, ok := ids[e.Slug]
		if !ok {
			continue
		}
		payload := emptyPayload
		if e.Emoji != "" {
			if payload, err = json.Marshal(map[string]string{"emoji": e.Emoji}); err != nil {
				return err
			}
		}
		rows = append(rows, []any{wid, e.Identity, string(e.Kind), payload, e.At})
	}
	if len(rows) == 0 {
		return nil
	}
	_, err = s.pool.CopyFrom(ctx, pgx.Identifier{"engagement_events"}, eventColumns, pgx.CopyFromRows(rows))
	return err
}

var _ capture.Sink = (*Store)(nil)

/* EngagementActivity is one person's full activity for their drawer, in one pipelined
 * batch, every query bounded by (webinar_id, identity). Anonymous questions are left out
 * on purpose: the dashboard must not re-attribute them. */
func (s *Store) EngagementActivity(ctx context.Context, webinarID, identity string) (engagement.Activity, *time.Time, error) {
	var (
		a     engagement.Activity
		start *time.Time
	)
	b := &pgx.Batch{}
	b.Queue(`SELECT started_at FROM webinars WHERE id = $1`, webinarID).
		QueryRow(func(row pgx.Row) error { return row.Scan(&start) })
	b.Queue(`
		SELECT identity, joined_at, left_at FROM attendance_visits
		 WHERE webinar_id = $1 AND identity = $2 ORDER BY joined_at`, webinarID, identity).
		Query(scanAll(&a.Visits, func(rows pgx.Rows, v *engagement.Visit) error {
			return rows.Scan(&v.Identity, &v.Joined, &v.Left)
		}))
	b.Queue(`
		SELECT sender_name, created_at, CASE WHEN message_type = 'image' THEN '[image]' ELSE left(content, 280) END
		  FROM chat_messages
		 WHERE webinar_id = $1 AND sender_identity = $2 AND deleted_at IS NULL
		 ORDER BY seq DESC LIMIT 400`, webinarID, identity).
		Query(scanAll(&a.Chats, func(rows pgx.Rows, c *engagement.ChatLine) error {
			return rows.Scan(&c.Name, &c.At, &c.Text)
		}))
	b.Queue(`
		SELECT id, body, created_at FROM session_questions
		 WHERE webinar_id = $1 AND identity = $2 AND NOT anonymous`, webinarID, identity).
		Query(scanAll(&a.Questions, func(rows pgx.Rows, q *engagement.Question) error {
			return rows.Scan(&q.ID, &q.Text, &q.At)
		}))
	b.Queue(`
		SELECT v.created_at, q.body FROM session_question_votes v
		  JOIN session_questions q ON q.id = v.question_id
		 WHERE q.webinar_id = $1 AND v.identity = $2`, webinarID, identity).
		Query(scanAll(&a.Upvotes, func(rows pgx.Rows, u *engagement.UpvoteOn) error {
			return rows.Scan(&u.At, &u.Question)
		}))
	b.Queue(`
		SELECT pv.voted_at, p.kind = 'quiz', COALESCE(p.options->>pv.choice, ''),
		       COALESCE(p.correct_option = pv.choice, false)
		  FROM poll_votes pv JOIN polls p ON p.id = pv.poll_id
		 WHERE p.webinar_id = $1 AND pv.identity = $2`, webinarID, identity).
		Query(scanAll(&a.Votes, func(rows pgx.Rows, v *engagement.VoteOn) error {
			return rows.Scan(&v.At, &v.Quiz, &v.Option, &v.Correct)
		}))
	b.Queue(`
		SELECT kind, COALESCE(payload->>'emoji', ''), occurred_at FROM engagement_events
		 WHERE webinar_id = $1 AND identity = $2
		 ORDER BY occurred_at DESC LIMIT 2000`, webinarID, identity).
		Query(scanAll(&a.Events, func(rows pgx.Rows, e *engagement.RawEvent) error {
			return rows.Scan(&e.Kind, &e.Value, &e.At)
		}))
	if err := s.pool.SendBatch(ctx, b).Close(); err != nil {
		if noRows(err) {
			return a, nil, ErrNotFound
		}
		return a, nil, err
	}
	return a, start, nil
}

/* WhatsAppConsent is whether the registrant's CRM contact (on the webinar host's account)
 * is currently opted in. Nil when there is no contact to consult. Same matching and the
 * same opt-in/opt-out rule the replay and reminder paths use. */
func (s *Store) WhatsAppConsent(ctx context.Context, webinarID, registrationID string) (*bool, error) {
	if registrationID == "" {
		return nil, nil
	}
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT (c.whatsapp_opt_in_at IS NOT NULL
		        AND (c.whatsapp_opt_out_at IS NULL OR c.whatsapp_opt_in_at > c.whatsapp_opt_out_at))
		  FROM registrations r
		  JOIN webinars w ON w.id = r.webinar_id
		  JOIN crm_contacts c ON c.host_id = w.host_id
		   AND (c.registration_id = r.id OR (r.email <> '' AND lower(c.email) = lower(r.email)))
		 WHERE r.id = $2 AND w.id = $1
		 ORDER BY (c.registration_id = r.id) DESC NULLS LAST, c.created_at
		 LIMIT 1`, webinarID, registrationID).Scan(&ok)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ok, nil
}
