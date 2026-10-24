package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// EdgeLiveness is what an instance needs to decide whether its open event streams still have
// a viewer behind them (api: edgeViewerGone).
type EdgeLiveness struct {
	// Live is whether the webinar is live now; StartedAt is when it went live (zero if never).
	Live      bool
	StartedAt time.Time
	// Watching is every identity with a believable visit: one the webhooks own, or an edge
	// visit whose browser beat within edgeVisitStale (the same filter OpenEdgeVisits counts).
	Watching map[string]struct{}
}

// EdgeVisitStale is how long an edge visit stays believable without a beat.
const EdgeVisitStale = edgeVisitStale

/* EdgeLivenessFor reads EdgeLiveness for one webinar in one query. Called at most once a
 * minute per instance per webinar with open streams, not per stream. ErrNotFound for an
 * unknown slug. */
func (s *Store) EdgeLivenessFor(ctx context.Context, slug string) (EdgeLiveness, error) {
	var (
		out     EdgeLiveness
		started *time.Time
		ids     []string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT w.status = 'live', w.started_at,
		       COALESCE(array_agg(DISTINCT v.identity) FILTER (WHERE v.identity IS NOT NULL), '{}')
		  FROM webinars w
		  LEFT JOIN attendance_visits v ON v.webinar_id = w.id AND `+liveEdgeVisit+`
		 WHERE w.slug = $1
		 GROUP BY w.id`, slug, edgeVisitStale).Scan(&out.Live, &started, &ids)
	if errors.Is(err, pgx.ErrNoRows) {
		return EdgeLiveness{}, ErrNotFound
	}
	if err != nil {
		return EdgeLiveness{}, err
	}
	if started != nil {
		out.StartedAt = *started
	}
	out.Watching = make(map[string]struct{}, len(ids))
	for _, id := range ids {
		out.Watching[id] = struct{}{}
	}
	return out, nil
}
