package types

/* Site-wide switches an admin sets (api/internal/api/site_settings.go):
 *
 *   GET /api/admin/site-settings   admin: the switches and when they last changed
 *   PUT /api/admin/site-settings   admin: set them
 *
 * Everyone else reads them from GET /api/config (AppConfig.DownloadsVisible), which the web
 * already fetches and caches, so no page pays an extra request. */

// SiteSettings is GET /api/admin/site-settings and the admin's PUT answer.
type SiteSettings struct {
	/* DownloadsVisible is whether /download and every link to it are shown to people who
	 * are not admins. False by default, while the apps are not ready. */
	DownloadsVisible bool `json:"downloadsVisible"`
	// UpdatedAt is RFC 3339; empty before an admin first saves.
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// SetSiteSettingsRequest is PUT /api/admin/site-settings.
type SetSiteSettingsRequest struct {
	DownloadsVisible bool `json:"downloadsVisible"`
}
