package store

import (
	"context"
	"errors"
	"time"

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

/* SetSeriesDelivery writes the delivery to a series' occurrences that have not run yet (draft
 * or scheduled), from occurrence index `from` on (0 for all), and returns their slugs so the
 * caller can drop them from its delivery cache. A live or ended occurrence keeps its own. */
func (s *Store) SetSeriesDelivery(ctx context.Context, seriesID, delivery string, from int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE webinars SET delivery = $2, updated_at = now()
		 WHERE series_id = $1::uuid AND COALESCE(occurrence_index, 0) >= $3
		   AND status IN ('draft', 'scheduled') AND delivery <> $2
		RETURNING slug`, seriesID, delivery, from)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

/* BackfillEdgeDelivery moves webinars that have not run yet onto edge when their room is, or
 * will be, on one of edgeProjects (the GCP and DO video servers): pinned there, or unpinned
 * and headed there — the host's assigned project when it is in candidates, else the first
 * candidate, the same order the first join uses (Server.firstChoice). An unpinned webinar
 * with no candidate at all is edge too. Only one-off and recurring webinars in this app, in
 * draft or scheduled: live and ended sessions, meetings, simulive and Zoom are untouched.
 * Returns the slugs it changed. */
func (s *Store) BackfillEdgeDelivery(ctx context.Context, edgeProjects, candidates []string) ([]string, error) {
	if edgeProjects == nil {
		edgeProjects = []string{}
	}
	if candidates == nil {
		candidates = []string{}
	}
	rows, err := s.pool.Query(ctx, `
		WITH target AS (
			SELECT w.id,
			       CASE WHEN w.sfu_project <> '' THEN w.sfu_project
			            WHEN u.sfu_project = ANY($2::text[]) THEN u.sfu_project
			            ELSE COALESCE(($2::text[])[1], '')
			       END AS project
			  FROM webinars w
			  LEFT JOIN users u ON u.id = w.host_id
			 WHERE w.delivery <> 'edge'
			   AND w.status IN ('draft', 'scheduled')
			   AND w.kind IN ('live', 'recurring')
			   AND w.venue = 'app'
		)
		UPDATE webinars w SET delivery = 'edge', updated_at = now()
		  FROM target t
		 WHERE w.id = t.id AND (t.project = '' OR t.project = ANY($1::text[]))
		RETURNING w.slug`, edgeProjects, candidates)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
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

/* edgeVisitStale is how long an edge visit stays open without a beat from the browser.
 *
 * The browser beats every 30 seconds (web/lib/edge-events.ts), and a background tab's timers
 * are throttled to about once a minute, so this allows two throttled beats to go missing
 * before somebody counts as gone. A visit that goes stale ends at its last beat, not at the
 * moment it was noticed: the beat is the last time anybody knew they were there. */
const edgeVisitStale = 150 * time.Second

/* liveEdgeVisit is the filter for an open visit that is still believable: one the webhooks own
 * (seen_at NULL), or an edge visit that beat recently. A stale one is not closed by a read;
 * SweepEdgeVisits does that. */
const liveEdgeVisit = `v.left_at IS NULL AND (v.seen_at IS NULL OR v.seen_at >= now() - $2::interval)`

/* OpenEdgeVisits is how many edge viewers are watching right now: attendee visits with no
 * departure whose browser has beaten recently (TouchEdgeVisit). This is the occupancy the
 * attendee limit is checked against for an edge webinar, where the video server cannot count
 * them. Every instance reads the same number, which a per-process count could not give. */
func (s *Store) OpenEdgeVisits(ctx context.Context, slug string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT v.identity)
		  FROM attendance_visits v JOIN webinars w ON w.id = v.webinar_id
		 WHERE w.slug = $1 AND `+liveEdgeVisit+` AND v.identity LIKE 'att\_%'`,
		slug, edgeVisitStale).Scan(&n)
	return n, err
}

/* TouchEdgeVisit is an edge viewer saying they are still watching: their event stream
 * connecting, or the beat their browser sends while the player is up.
 *
 * Their open visit's seen_at moves forward, or a visit opens if they have none. That second
 * case is what lets somebody who connected on the waiting screen be counted from the moment
 * the host goes live, rather than from their stream's next reconnect up to 25 minutes later.
 * Nothing opens for a webinar that is not live, or for somebody the host removed from this
 * run.
 *
 * A visit that went stale first (a laptop that slept, a phone that lost signal) is closed at
 * its last beat before the new one opens, so the gap is not counted as watching.
 *
 * A visit the webhooks own (seen_at NULL: this person is on the stage) is left alone. */
func (s *Store) TouchEdgeVisit(ctx context.Context, slug, identity string, at time.Time) error {
	if identity == "" {
		return nil
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = v.seen_at
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1 AND v.identity = $2
		   AND v.left_at IS NULL AND v.seen_at < $3::timestamptz - $4::interval`,
		slug, identity, at, edgeVisitStale); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO attendance_visits (webinar_id, identity, joined_at, seen_at)
		SELECT w.id, $2, $3, $3 FROM webinars w
		 WHERE w.slug = $1 AND w.status = 'live'
		   AND NOT EXISTS (
		     SELECT 1 FROM room_removals rr
		      WHERE rr.webinar_id = w.id AND rr.identity = $2
		        AND rr.removed_at >= COALESCE(w.started_at, '-infinity'::timestamptz))
		ON CONFLICT (webinar_id, identity) WHERE left_at IS NULL DO UPDATE
		   SET seen_at = GREATEST(attendance_visits.seen_at, EXCLUDED.seen_at)
		 WHERE attendance_visits.seen_at IS NOT NULL`,
		slug, identity, at)
	return err
}

/* CloseEdgeVisit is an edge viewer leaving on purpose: the Leave button, or the page going
 * away (the browser's beacon), or the host removing them. Only an edge visit — one the
 * webhooks own is theirs to close. */
func (s *Store) CloseEdgeVisit(ctx context.Context, slug, identity string, at time.Time) error {
	if identity == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = GREATEST($3, v.joined_at)
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1
		   AND v.identity = $2 AND v.left_at IS NULL AND v.seen_at IS NOT NULL`,
		slug, identity, at)
	return err
}

/* SweepEdgeVisits closes every edge visit on a webinar whose beats stopped, at its last beat.
 *
 * The viewer who closes a tab without the beacon getting out (a phone killing the browser, a
 * dropped network) never says goodbye, so this is how their visit ends. Run before the report
 * is read, so an open stale visit is not counted against now() while the session is live. */
func (s *Store) SweepEdgeVisits(ctx context.Context, slug string, at time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE attendance_visits v
		   SET left_at = v.seen_at
		  FROM webinars w
		 WHERE v.webinar_id = w.id AND w.slug = $1
		   AND v.left_at IS NULL AND v.seen_at < $2::timestamptz - $3::interval`,
		slug, at, edgeVisitStale)
	return err
}

// EdgeViewer is one person watching the edge feed right now, for the host's roster.
type EdgeViewer struct {
	Identity string
	Name     string
	JoinedAt time.Time
}

/* OpenEdgeViewers is who OpenEdgeVisits counts, by name: the host's Participants panel lists
 * them beside the people on the video server, which cannot see them. The name is the one the
 * event stream connected with (the events handler writes it to attendance). */
func (s *Store) OpenEdgeViewers(ctx context.Context, slug string) ([]EdgeViewer, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT v.identity, COALESCE(a.name, ''), min(v.joined_at)
		  FROM attendance_visits v
		  JOIN webinars w ON w.id = v.webinar_id
		  LEFT JOIN attendance a ON a.webinar_id = v.webinar_id AND a.identity = v.identity
		 WHERE w.slug = $1 AND `+liveEdgeVisit+` AND v.identity LIKE 'att\_%'
		 GROUP BY v.identity, a.name
		 ORDER BY min(v.joined_at)`, slug, edgeVisitStale)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (EdgeViewer, error) {
		var v EdgeViewer
		err := row.Scan(&v.Identity, &v.Name, &v.JoinedAt)
		return v, err
	})
}
