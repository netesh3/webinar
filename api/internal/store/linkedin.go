package store

import (
	"context"
	"time"
)

/* LinkedIn Live destinations. See migrations/0118.
 *
 * Read through these functions rather than userColumns: only the encoder path
 * and the Settings card need it, and the ingest carries the stream key. */

// LinkedInDestination is the host's saved LinkedIn ingest (key included) and
// when it was saved. Empty ingest means not set up.
func (s *Store) LinkedInDestination(ctx context.Context, userID string) (ingest string, setAt *time.Time, err error) {
	err = s.pool.QueryRow(ctx,
		`SELECT linkedin_ingest, linkedin_set_at FROM users WHERE id = $1`, userID).Scan(&ingest, &setAt)
	if noRows(err) {
		return "", nil, ErrNotFound
	}
	return ingest, setAt, err
}

// SetLinkedInDestination saves the ingest. An empty one removes it.
func (s *Store) SetLinkedInDestination(ctx context.Context, userID, ingest string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET linkedin_ingest = $2,
		       linkedin_set_at = CASE WHEN $2 = '' THEN NULL ELSE now() END
		 WHERE id = $1`, userID, ingest)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// WebinarLinkedInPaused reports whether the host paused LinkedIn in this room.
func (s *Store) WebinarLinkedInPaused(ctx context.Context, slug string) (bool, error) {
	var paused bool
	err := s.pool.QueryRow(ctx,
		`SELECT linkedin_paused FROM webinars WHERE slug = $1 OR id::text = $1`, slug).Scan(&paused)
	if noRows(err) {
		return false, ErrNotFound
	}
	return paused, err
}

// SetWebinarLinkedInPaused pauses or resumes LinkedIn for one webinar.
func (s *Store) SetWebinarLinkedInPaused(ctx context.Context, slug string, paused bool) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE webinars SET linkedin_paused = $2 WHERE slug = $1 OR id::text = $1`, slug, paused)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// HostLiveWebinarSlugs is every webinar this host has live right now — the
// rooms a change to their LinkedIn details has to reach immediately.
func (s *Store) HostLiveWebinarSlugs(ctx context.Context, hostID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT slug FROM webinars WHERE host_id = $1 AND status = 'live'`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		out = append(out, slug)
	}
	return out, rows.Err()
}
