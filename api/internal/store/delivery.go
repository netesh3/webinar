package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

/* SetWebinarDelivery writes how the audience receives the session (types.Webinar.Delivery).
 *
 * Its own statement rather than a column in CreateWebinar/UpdateWebinar, the same way the
 * Zoom venue is saved (SetWebinarZoom): the handler validates the choice against the host's
 * features first, and the big upserts stay exactly as they were for every other field. */
func (s *Store) SetWebinarDelivery(ctx context.Context, slug, delivery string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET delivery = $2, updated_at = now() WHERE slug = $1`, slug, delivery)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// WebinarDelivery is the delivery mode alone, for hot paths that must not load a whole webinar.
func (s *Store) WebinarDelivery(ctx context.Context, slug string) (string, error) {
	var d string
	err := s.pool.QueryRow(ctx, `SELECT delivery FROM webinars WHERE slug = $1`, slug).Scan(&d)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return d, err
}

// PGNotify sends one Postgres NOTIFY (realtime.Notifier). pg_notify rather than the NOTIFY
// statement so the channel and payload are parameters, not interpolated text. Not to be
// confused with Notify, which queues an email notification.
func (s *Store) PGNotify(ctx context.Context, channel, payload string) error {
	_, err := s.pool.Exec(ctx, `SELECT pg_notify($1, $2)`, channel, payload)
	return err
}

/* ListenConn opens a connection outside the pool, for a LISTEN that runs as long as the
 * process does. Same settings as the pool's connections. Needs a session-mode connection:
 * Supabase's session pooler (:5432) and a direct connection both work; the transaction
 * pooler (:6543) does not deliver notifications. */
func (s *Store) ListenConn(ctx context.Context) (*pgx.Conn, error) {
	return pgx.ConnectConfig(ctx, s.pool.Config().ConnConfig.Copy())
}

/* OpenEdgeVisits is how many edge viewers are watching right now: attendee visits with no
 * departure. An edge viewer's visit opens when their event stream connects and closes when
 * it ends (see the events handler), so this is the occupancy the attendee limit is checked
 * against for an edge webinar, where the video server cannot count them. Every instance
 * reads the same number, which a per-process count could not give. */
func (s *Store) OpenEdgeVisits(ctx context.Context, slug string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT v.identity)
		  FROM attendance_visits v JOIN webinars w ON w.id = v.webinar_id
		 WHERE w.slug = $1 AND v.left_at IS NULL AND v.identity LIKE 'att\_%'`, slug).Scan(&n)
	return n, err
}
