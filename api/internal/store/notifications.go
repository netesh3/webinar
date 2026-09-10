package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/netkumar/webcast/api/types"
)

/* Querier is "something you can Exec against" — the pool or a transaction.
 *
 * It exists so Notify can be called from inside a caller's transaction. Both *pgxpool.Pool
 * and pgx.Tx satisfy it without any adapter, which is the point: the caller decides whether
 * the notification is atomic with the change that caused it, and does not need a second
 * method to say so.
 */
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

/* Telling people things.
 *
 * The approval workflow worked before this file existed: a pending registration showed up in
 * the host's registrants tab, and approving one unlocked the join button. What was missing was
 * anybody being informed. A host had to remember to go and look; an approved registrant had no
 * way to learn they were in without revisiting the page. For a session starting in fifteen
 * minutes that is not a workflow, it is a race.
 *
 * This is an OUTBOX rather than a send-and-hope. Rows are written next to the change they
 * describe, so a notification cannot be lost because the process died between committing an
 * approval and reaching an SMTP server. Delivery reads the table afterwards and is allowed to
 * fail without losing the fact that something is owed.
 *
 * See migrations/0010_notifications.sql for why in-app alerts and email share one table.
 */

// Notification is one thing somebody needs to be told.
type Notification struct {
	ID     string
	UserID string // set for a host alert; empty for a registrant invitation
	Email  string // set for a registrant invitation; empty for a host alert
	Kind   types.NotificationKind
	// Slug, not the uuid. The caller already has the slug on every path that emits one, and
	// resolving it in the INSERT saves a round trip whose only purpose would be to translate
	// an identifier the caller was holding anyway.
	WebinarSlug string
	Subject     string
	Body        string
}

/* Notify writes one notification.
 *
 * Takes a Querier rather than using the pool directly so it can join the caller's transaction.
 * That is the difference between an outbox and a log: a host alert written in the same
 * transaction as the pending registration either both happen or neither does, and there is no
 * window where somebody is waiting and nobody was told.
 */
func (s *Store) Notify(ctx context.Context, q Querier, n Notification) error {
	_, err := q.Exec(ctx, `
		INSERT INTO notifications (user_id, email, kind, webinar_id, subject, body)
		VALUES (NULLIF($1,'')::uuid, $2, $3,
		        (SELECT id FROM webinars WHERE slug = $4), $5, $6)`,
		n.UserID, strings.ToLower(strings.TrimSpace(n.Email)), string(n.Kind),
		n.WebinarSlug, n.Subject, n.Body)
	return err
}

// DB returns the pool as a Querier, for callers that are not inside a transaction.
//
// Narrow on purpose: it hands out "something you can Exec against", not *pgxpool.Pool, so a
// caller cannot start reaching past the store for things the store should be doing.
func (s *Store) DB() Querier { return s.pool }

/* HostAlerts returns a host's in-app notifications, newest first.
 *
 * Scoped to user_id, which is the whole access rule for this endpoint: there is no route that
 * takes a user id, so a caller can only ever read their own. `unreadOnly` serves the badge;
 * the full list serves the panel.
 */
func (s *Store) HostAlerts(ctx context.Context, userID string, unreadOnly bool, limit int) ([]types.HostAlert, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	where := ""
	if unreadOnly {
		where = " AND n.read_at IS NULL"
	}

	rows, err := s.pool.Query(ctx, `
		SELECT n.id::text, n.kind, COALESCE(w.slug,''), COALESCE(w.topic,''),
		       n.subject, n.body, n.read_at IS NULL, n.created_at
		  FROM notifications n
		  LEFT JOIN webinars w ON w.id = n.webinar_id
		 WHERE n.user_id = $1`+where+`
		 ORDER BY n.created_at DESC
		 LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []types.HostAlert{}
	for rows.Next() {
		var (
			a         types.HostAlert
			createdAt time.Time
		)
		if err := rows.Scan(&a.ID, &a.Kind, &a.WebinarID, &a.Topic,
			&a.Subject, &a.Body, &a.Unread, &createdAt); err != nil {
			return nil, err
		}
		a.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, a)
	}
	return out, rows.Err()
}

// UnreadAlertCount backs the badge, which is the only thing most page loads need.
func (s *Store) UnreadAlertCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM notifications
		 WHERE user_id = $1 AND read_at IS NULL`, userID).Scan(&n)
	return n, err
}

/* MarkAlertsRead marks a host's alerts read; an empty id list means all of them.
 *
 * The user_id predicate is not decoration. Without it, an id in a request body would let one
 * host mark another host's alerts read — harmless-looking, and it would hide a pending
 * registration from the person who needed to act on it.
 */
func (s *Store) MarkAlertsRead(ctx context.Context, userID string, ids []string) (int, error) {
	var (
		tag interface{ RowsAffected() int64 }
		err error
	)
	if len(ids) == 0 {
		tag, err = s.pool.Exec(ctx, `
			UPDATE notifications SET read_at = now()
			 WHERE user_id = $1 AND read_at IS NULL`, userID)
	} else {
		if len(ids) > 1000 {
			ids = ids[:1000]
		}
		tag, err = s.pool.Exec(ctx, `
			UPDATE notifications SET read_at = now()
			 WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2)`, userID, ids)
	}
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// Outbound is one notification still owed to a transport.
type Outbound struct {
	ID      string
	Email   string
	Subject string
	Body    string
}

/* PendingDeliveries returns notifications with an address and nothing sent yet.
 *
 * Only rows with an email: a host alert is delivered by being rendered in the app, so it has
 * no transport to wait for and must not sit in this queue for ever.
 */
func (s *Store) PendingDeliveries(ctx context.Context, limit int) ([]Outbound, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, email, subject, body
		  FROM notifications
		 WHERE delivery = 'pending' AND email <> ''
		 ORDER BY created_at
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Outbound{}
	for rows.Next() {
		var o Outbound
		if err := rows.Scan(&o.ID, &o.Email, &o.Subject, &o.Body); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// MarkDelivered records the outcome of one send attempt. `reason` is kept for
// 'failed' and 'skipped' so an operator can tell a missing SMTP config from a
// rejected address without reading process logs that have since rotated away.
func (s *Store) MarkDelivered(ctx context.Context, id, delivery, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications
		   SET delivery = $2, delivery_error = $3, delivered_at = now()
		 WHERE id = $1`, id, delivery, reason)
	return err
}
