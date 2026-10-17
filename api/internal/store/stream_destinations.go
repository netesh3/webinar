package store

import (
	"context"
	"errors"
	"time"
)

/* Live-stream destinations a host saves once: LinkedIn, Instagram, Facebook.
 * See migrations 0118 and 0119.
 *
 * One set of columns per platform, picked from a fixed list here — the platform
 * name is never spliced into SQL unchecked. Read through these functions rather
 * than userColumns: only the encoder path and the Settings card need them, and
 * the ingest carries the stream key. */

// ErrUnknownPlatform is a platform with no columns.
var ErrUnknownPlatform = errors.New("unknown streaming platform")

var streamPlatforms = map[string]struct{ ingest, setAt, paused string }{
	"linkedin":  {"linkedin_ingest", "linkedin_set_at", "linkedin_paused"},
	"instagram": {"instagram_ingest", "instagram_set_at", "instagram_paused"},
	"facebook":  {"facebook_ingest", "facebook_set_at", "facebook_paused"},
}

// StreamDestination is the host's saved ingest for a platform (key included)
// and when it was saved. Empty ingest means not set up.
func (s *Store) StreamDestination(ctx context.Context, userID, platform string) (ingest string, setAt *time.Time, err error) {
	cols, ok := streamPlatforms[platform]
	if !ok {
		return "", nil, ErrUnknownPlatform
	}
	err = s.pool.QueryRow(ctx,
		`SELECT `+cols.ingest+`, `+cols.setAt+` FROM users WHERE id = $1`, userID).Scan(&ingest, &setAt)
	if noRows(err) {
		return "", nil, ErrNotFound
	}
	return ingest, setAt, err
}

// SetStreamDestination saves the ingest. An empty one removes it.
func (s *Store) SetStreamDestination(ctx context.Context, userID, platform, ingest string) error {
	cols, ok := streamPlatforms[platform]
	if !ok {
		return ErrUnknownPlatform
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		   SET `+cols.ingest+` = $2,
		       `+cols.setAt+` = CASE WHEN $2 = '' THEN NULL ELSE now() END
		 WHERE id = $1`, userID, ingest)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// WebinarStreamPaused reports whether the host paused a platform in this room.
func (s *Store) WebinarStreamPaused(ctx context.Context, slug, platform string) (bool, error) {
	cols, ok := streamPlatforms[platform]
	if !ok {
		return false, ErrUnknownPlatform
	}
	var paused bool
	err := s.pool.QueryRow(ctx,
		`SELECT `+cols.paused+` FROM webinars WHERE slug = $1 OR id::text = $1`, slug).Scan(&paused)
	if noRows(err) {
		return false, ErrNotFound
	}
	return paused, err
}

// SetWebinarStreamPaused pauses or resumes a platform for one webinar.
func (s *Store) SetWebinarStreamPaused(ctx context.Context, slug, platform string, paused bool) error {
	cols, ok := streamPlatforms[platform]
	if !ok {
		return ErrUnknownPlatform
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE webinars SET `+cols.paused+` = $2 WHERE slug = $1 OR id::text = $1`, slug, paused)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// HostLiveWebinarSlugs is every webinar this host has live right now — the
// rooms a change to a saved destination has to reach immediately.
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
