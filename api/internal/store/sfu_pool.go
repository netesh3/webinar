package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

/* The box pool's reads (api/internal/api/sfu_pool.go): which sessions sit on which video
 * server, so a new one goes where there is room, and which upcoming sessions are still unplaced.
 *
 * A session's project is boxProjectOf, the same expression SFUBoxDemand uses, so the pool and
 * each box's own up/down decision always agree on where a session is. */

// PoolSession is a session holding a place on a video server.
type PoolSession struct {
	Slug    string
	Project string
	Status  string
	Kind    string
	// StartsAt is when it is scheduled to begin (zero when unknown).
	StartsAt time.Time
}

/* PoolSessions is every session that holds points on one of projects now: live (a simulive
 * with its doors open included), scheduled to start within warmLead (or up to boxLateStart
 * late), or still recording or uploading. defaultProject is where an unpinned session of a host
 * with no assignment goes. Ended sessions whose recording is done hold nothing. */
func (s *Store) PoolSessions(ctx context.Context, projects []string, defaultProject string, warmLead time.Duration) ([]PoolSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug, `+boxProjectOf+` AS project, w.status, w.kind, coalesce(w.starts_at, 'epoch'::timestamptz)
		  FROM webinars w LEFT JOIN users u ON u.id = w.host_id
		 WHERE (w.status = 'live'
		        OR (w.status = 'scheduled' AND w.kind = 'simulive' AND w.simulive_doors_open)
		        OR (w.status = 'scheduled'
		            AND w.starts_at <= now() + make_interval(secs => $3)
		            AND w.starts_at >= now() - make_interval(secs => $4))
		        OR EXISTS (SELECT 1 FROM recordings r
		                    WHERE r.webinar_id = w.id AND r.status IN ('recording', 'processing')
		                      AND r.created_at > now() - interval '12 hours'))
		   AND `+boxProjectOf+` = ANY($1::text[])
		 ORDER BY w.starts_at NULLS LAST, w.slug`,
		projects, defaultProject, warmLead.Seconds(), boxLateStart.Seconds())
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (PoolSession, error) {
		var p PoolSession
		err := row.Scan(&p.Slug, &p.Project, &p.Status, &p.Kind, &p.StartsAt)
		return p, err
	})
}

/* UnplacedSoon is the scheduled sessions starting within warmLead (or up to boxLateStart late)
 * that have no video server pinned yet, earliest first: the pool places them ahead of their
 * start so the box they need is up in time. Zoom-hosted sessions never use a video server. */
func (s *Store) UnplacedSoon(ctx context.Context, warmLead time.Duration) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.slug FROM webinars w
		 WHERE coalesce(w.sfu_project, '') = ''
		   AND coalesce(w.venue, 'app') NOT LIKE 'zoom%'
		   AND w.status = 'scheduled'
		   AND w.starts_at <= now() + make_interval(secs => $1)
		   AND w.starts_at >= now() - make_interval(secs => $2)
		 ORDER BY w.starts_at, w.slug`, warmLead.Seconds(), boxLateStart.Seconds())
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// SetSessionRegion sets the area of the box pool a session's video server is in ("" is the default).
func (s *Store) SetSessionRegion(ctx context.Context, slug, region string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE webinars SET sfu_region = $2, updated_at = now() WHERE slug = $1`, slug, region)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetSeriesRegion is SetSessionRegion for every occurrence of a series that has not ended.
func (s *Store) SetSeriesRegion(ctx context.Context, seriesID, region string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE webinars SET sfu_region = $2, updated_at = now()
		 WHERE series_id::text = $1 AND status IN ('draft', 'scheduled')`, seriesID, region)
	return err
}
