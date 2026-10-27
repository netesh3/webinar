package types

/* The site-wide maintenance banner (api/internal/api/site_banner.go):
 *
 *   GET /api/site-banner         public: whether it is on and its message
 *   PUT /api/admin/site-banner   admin: turn it on or off, set the message
 *
 * Shown to everyone but admins, across the marketing pages, the host app and the rooms. */

// SiteBannerMaxRunes bounds the message.
const SiteBannerMaxRunes = 280

// SiteBannerDefaultMessage is shown when the admin turns it on without writing one.
const SiteBannerDefaultMessage = "We're doing scheduled maintenance. Live webinars and meetings may be unavailable for a short while. We're sorry for the inconvenience."

// SiteBanner is GET /api/site-banner and the admin's PUT answer.
type SiteBanner struct {
	Enabled bool   `json:"enabled"`
	Message string `json:"message"`
	// UpdatedAt is RFC 3339; empty before an admin first saves.
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// SetSiteBannerRequest is PUT /api/admin/site-banner. An empty message means the default.
type SetSiteBannerRequest struct {
	Enabled bool   `json:"enabled"`
	Message string `json:"message"`
}
