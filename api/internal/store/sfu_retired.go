package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

/* Moving webinars off a retired video server (api/internal/api/sfu_retired.go). */

/* MoveSFUProject repins a webinar that has not run yet from one project to another, only if
 * it is still pinned to `from` and still draft or scheduled. False when it was not: somebody
 * else moved it first, or it started. */
func (s *Store) MoveSFUProject(ctx context.Context, slug, from, to string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE webinars SET sfu_project = $3
		 WHERE slug = $1 AND sfu_project = $2 AND status IN ('draft', 'scheduled')`,
		slug, from, to)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// UnrunWebinarsOn is the slugs of draft and scheduled webinars pinned to any of projects.
func (s *Store) UnrunWebinarsOn(ctx context.Context, projects []string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT slug FROM webinars
		 WHERE sfu_project = ANY($1::text[]) AND status IN ('draft', 'scheduled')
		 ORDER BY starts_at NULLS LAST, slug`, projects)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// UnassignHostsFrom clears every host's video-server assignment to any of projects.
func (s *Store) UnassignHostsFrom(ctx context.Context, projects []string) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE users SET sfu_project = NULL WHERE sfu_project = ANY($1::text[])`, projects)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
