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
	/* Channel is "email" (the default when empty) or "whatsapp".
	 *
	 * A WhatsApp row is addressed to a ContactID and carries a template instead of a
	 * Subject and Body, because Meta will not deliver a business's own words to
	 * somebody who has not written in within the last 24 hours — and a reminder, by
	 * definition, arrives when nobody has. See migrations/0043 for why this is the
	 * same table rather than a second queue. */
	Channel          string
	ContactID        string
	TemplateName     string
	TemplateLanguage string
	// TemplateParams fill the template's {{1}}, {{2}} … in order, already resolved
	// for this recipient.
	TemplateParams []string
	/* BroadcastID is set on exactly the broadcast rows, and on nothing else — the
	 * constraint in 0044 enforces the "exactly". The reminder sweeps use its absence
	 * to mean "this is not part of a broadcast", so moving a webinar cannot rewrite
	 * the due time of a message the host scheduled themselves. */
	BroadcastID string
	/* DripEnrollmentID is set on exactly the drip rows, by the same rule and the same
	 * kind of constraint in 0045. One row per step per person, written when the step
	 * comes due rather than when they were enrolled: the time of the third message is
	 * not knowable until the second has gone. */
	DripEnrollmentID string
	// Slug, not the uuid. The caller already has the slug on every path that emits one, and
	// resolving it in the INSERT saves a round trip whose only purpose would be to translate
	// an identifier the caller was holding anyway.
	WebinarSlug    string
	Subject        string
	Body           string
	ICS            string
	RegistrationID string
	DueAt          time.Time // zero means send as soon as the outbox is flushed
}

/* Notify writes one notification.
 *
 * Takes a Querier rather than using the pool directly so it can join the caller's transaction.
 * That is the difference between an outbox and a log: a host alert written in the same
 * transaction as the pending registration either both happen or neither does, and there is no
 * window where somebody is waiting and nobody was told.
 */
func (s *Store) Notify(ctx context.Context, q Querier, n Notification) error {
	due := n.DueAt
	if due.IsZero() {
		due = time.Now()
	}
	channel := n.Channel
	if channel == "" {
		channel = "email"
	}
	params := n.TemplateParams
	if params == nil {
		// '[]', not 'null': the column is jsonb and the send path indexes into it.
		params = []string{}
	}
	_, err := q.Exec(ctx, `
		INSERT INTO notifications (user_id, email, kind, webinar_id, subject, body, ics, registration_id, due_at,
		                           channel, contact_id, template_name, template_language, template_params,
		                           broadcast_id, drip_enrollment_id)
		VALUES (NULLIF($1,'')::uuid, $2, $3,
		        (SELECT id FROM webinars WHERE slug = $4), $5, $6, $7, NULLIF($8,'')::uuid, $9,
		        $10, NULLIF($11,'')::uuid, $12, $13, $14, NULLIF($15,'')::uuid,
		        NULLIF($16,'')::uuid)`,
		n.UserID, strings.ToLower(strings.TrimSpace(n.Email)), string(n.Kind),
		n.WebinarSlug, n.Subject, n.Body, n.ICS, n.RegistrationID, due,
		channel, n.ContactID, n.TemplateName, n.TemplateLanguage, params, n.BroadcastID,
		n.DripEnrollmentID)
	if isUniqueViolation(err) {
		return nil
	}
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
	ID       string
	Email    string
	Subject  string
	Body     string
	ICS      string
	Attempts int
}

/* PendingDeliveries returns notifications with an address that are due now.
 *
 * Only rows with an email: a host alert is delivered by being rendered in the app, so it has
 * no transport to wait for and must not sit in this queue for ever.
 */
func (s *Store) PendingDeliveries(ctx context.Context, limit int) ([]Outbound, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, email, subject, body, ics, attempts
		  FROM notifications
		 WHERE delivery = 'pending' AND email <> '' AND due_at <= now()
		   AND (webinar_id IS NULL OR EXISTS (
		         SELECT 1 FROM webinars w
		          WHERE w.id = notifications.webinar_id
		            /* The replay is the one message that is ABOUT a webinar being over, so
		             * it is the one that must survive the session ending — every other kind
		             * here is a promise about something that is going to happen, and an
		             * ended webinar is the reason not to keep it. */
		            AND (notifications.kind = 'replay_ready' OR (
		              w.status NOT IN ('ended','draft')
		              AND (
		                notifications.kind NOT IN ('reminder_24h','reminder_1h')
		                OR COALESCE((w.options->>'emailReminders')::boolean, true)
		              )
		            ))
		       ))
		   AND (registration_id IS NULL OR EXISTS (
		         SELECT 1 FROM registrations r
		          WHERE r.id = notifications.registration_id
		            AND r.state = 'approved'
		            AND r.email <> ''
		       ))
		 ORDER BY due_at, created_at
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Outbound{}
	for rows.Next() {
		var o Outbound
		if err := rows.Scan(&o.ID, &o.Email, &o.Subject, &o.Body, &o.ICS, &o.Attempts); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

const maxDeliveryAttempts = 8

// RecordSendAttempt records a send. Failed rows with attempts left are scheduled
// again (exponential backoff) rather than left pending for the same flush to retry.
func (s *Store) RecordSendAttempt(ctx context.Context, id, delivery, reason string) error {
	if delivery == "failed" {
		_, err := s.pool.Exec(ctx, `
			UPDATE notifications
			   SET attempts = attempts + 1,
			       delivery = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
			       delivery_error = $2,
			       delivered_at = now(),
			       due_at = now() + make_interval(secs => LEAST(900, 30 * POWER(2, attempts)::int))
			 WHERE id = $1`, id, reason, maxDeliveryAttempts)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications
		   SET delivery = $2, delivery_error = $3, delivered_at = now()
		 WHERE id = $1`, id, delivery, reason)
	return err
}

// MarkDelivered records the outcome of one send attempt. `reason` is kept for
// 'failed' and 'skipped' so an operator can tell a missing SMTP config from a
// rejected address without reading process logs that have since rotated away.
func (s *Store) MarkDelivered(ctx context.Context, id, delivery, reason string) error {
	return s.RecordSendAttempt(ctx, id, delivery, reason)
}

/* The three statements below all name the WhatsApp kinds alongside the email ones.
 *
 * Every one of them is a promise about a message that has not gone out yet, and a
 * WhatsApp message is the one where breaking it costs the host money and lands on
 * somebody's phone: a reminder for a webinar that was cancelled, or one that still
 * says "in an hour" three hours after it was moved. Whenever a kind is added to the
 * outbox it has to be added here too, which is why they are kept together.
 */

/* SkipPendingRemindersForRegistration drops unsent reminders when a seat is declined.
 *
 * The WhatsApp confirmation is in the list and the email one is not, because they
 * are queued at different moments: the email confirmation is only written once a
 * registration is approved, while the WhatsApp one is written on registration and
 * held by the sweep until the host decides. A decline is that decision, and the row
 * would otherwise wait for an approval that is never coming.
 */
func (s *Store) SkipPendingRemindersForRegistration(ctx context.Context, registrationID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications
		   SET delivery = 'skipped', delivery_error = 'registration declined', delivered_at = now()
		 WHERE registration_id = $1
		   AND delivery = 'pending'
		   AND kind IN ('reminder_24h','reminder_1h',
		                'wa_reminder_24h','wa_reminder_1h','wa_registration_confirmed')`, registrationID)
	return err
}

/* RescheduleRemindersForWebinar moves unsent 24h/1h due times when the host changes starts_at.
 *
 * $2 is cast explicitly, and it matters: without the cast Postgres resolves the
 * parameter's type from `$2 - interval '24 hours'`, decides it is an interval, and
 * rejects the whole statement — which the caller logs as a warning and carries on
 * from, so every reschedule quietly left the old reminders where they were.
 */
func (s *Store) RescheduleRemindersForWebinar(ctx context.Context, slug string, startsAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications n
		   SET due_at = CASE n.kind
		                  WHEN 'reminder_24h'    THEN $2::timestamptz - interval '24 hours'
		                  WHEN 'reminder_1h'     THEN $2::timestamptz - interval '1 hour'
		                  WHEN 'wa_reminder_24h' THEN $2::timestamptz - interval '24 hours'
		                  WHEN 'wa_reminder_1h'  THEN $2::timestamptz - interval '1 hour'
		                END
		  FROM webinars w
		 WHERE n.webinar_id = w.id AND w.slug = $1
		   AND n.delivery = 'pending'
		   AND n.kind IN ('reminder_24h','reminder_1h','wa_reminder_24h','wa_reminder_1h')`, slug, startsAt)
	return err
}

// SkipRemindersForEndedWebinar stops telling people about a session that will not happen.
func (s *Store) SkipRemindersForEndedWebinar(ctx context.Context, slug string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE notifications n
		   SET delivery = 'skipped', delivery_error = 'webinar ended', delivered_at = now()
		  FROM webinars w
		 WHERE n.webinar_id = w.id AND w.slug = $1
		   AND n.delivery = 'pending'
		   AND n.kind IN ('reminder_24h','reminder_1h','registration_confirmed','registration_approved',
		                  'wa_reminder_24h','wa_reminder_1h','wa_registration_confirmed')
		   AND n.due_at > now()`, slug)
	return err
}
