package store

import (
	"context"
	"time"
)

// SiteSettings is the one row of site_settings (migration 0184).
type SiteSettings struct {
	DownloadsVisible bool
	UpdatedAt        time.Time
}

// SiteSettings reads the site-wide switches. No row reads as every switch at its default.
func (s *Store) SiteSettings(ctx context.Context) (SiteSettings, error) {
	var v SiteSettings
	err := s.pool.QueryRow(ctx, `SELECT downloads_visible, updated_at FROM site_settings WHERE id = 1`).
		Scan(&v.DownloadsVisible, &v.UpdatedAt)
	if noRows(err) {
		return SiteSettings{}, nil
	}
	return v, err
}

// SetSiteSettings writes the site-wide switches, recording who did it.
func (s *Store) SetSiteSettings(ctx context.Context, downloadsVisible bool, adminID string) (SiteSettings, error) {
	var v SiteSettings
	err := s.pool.QueryRow(ctx, `
		INSERT INTO site_settings (id, downloads_visible, updated_at, updated_by)
		VALUES (1, $1, now(), NULLIF($2, '')::uuid)
		ON CONFLICT (id) DO UPDATE
		   SET downloads_visible = EXCLUDED.downloads_visible,
		       updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
		RETURNING downloads_visible, updated_at`, downloadsVisible, adminID).
		Scan(&v.DownloadsVisible, &v.UpdatedAt)
	return v, err
}
