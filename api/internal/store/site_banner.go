package store

import (
	"context"
	"time"
)

// SiteBanner is the one row of site_banner (migration 0169).
type SiteBanner struct {
	Enabled   bool
	Message   string
	UpdatedAt time.Time
}

// SiteBanner reads the maintenance banner. No row reads as off.
func (s *Store) SiteBanner(ctx context.Context) (SiteBanner, error) {
	var b SiteBanner
	err := s.pool.QueryRow(ctx, `SELECT enabled, message, updated_at FROM site_banner WHERE id = 1`).
		Scan(&b.Enabled, &b.Message, &b.UpdatedAt)
	if noRows(err) {
		return SiteBanner{}, nil
	}
	return b, err
}

// SetSiteBanner turns the banner on or off and sets its message, recording who did it.
func (s *Store) SetSiteBanner(ctx context.Context, enabled bool, message, adminID string) (SiteBanner, error) {
	var b SiteBanner
	err := s.pool.QueryRow(ctx, `
		INSERT INTO site_banner (id, enabled, message, updated_at, updated_by)
		VALUES (1, $1, $2, now(), NULLIF($3, '')::uuid)
		ON CONFLICT (id) DO UPDATE
		   SET enabled = EXCLUDED.enabled, message = EXCLUDED.message,
		       updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
		RETURNING enabled, message, updated_at`, enabled, message, adminID).
		Scan(&b.Enabled, &b.Message, &b.UpdatedAt)
	return b, err
}
