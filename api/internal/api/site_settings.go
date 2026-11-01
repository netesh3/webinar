package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* Site-wide switches (types/site_settings.go), set from Admin -> Dashboard -> Site settings.
 * The first is DownloadsVisible: /download stays hidden until the desktop and mobile apps are
 * ready (1 Nov 2026).
 *
 * Everyone reads the switches through GET /api/config, which every page render already makes,
 * so the row is kept here for siteSettingsTTL and replaced on every admin write rather than
 * read from the database per request. The web keeps /api/config for TTL_CONFIG (five
 * minutes, web/lib/http.ts), so a change reaches every page within about five minutes. */

const siteSettingsTTL = 30 * time.Second

// siteSettingsCache is this process's copy of the row. The zero value is empty.
type siteSettingsCache struct {
	mu   sync.Mutex
	at   time.Time
	have bool
	val  types.SiteSettings
}

func (c *siteSettingsCache) put(v types.SiteSettings) {
	c.mu.Lock()
	c.val, c.at, c.have = v, time.Now(), true
	c.mu.Unlock()
}

/* siteSettings is the cached row. A read that fails answers with every switch at its default
 * (hidden) and is not cached, so the next request tries again: /api/config must not fail
 * because of it. */
func (s *Server) siteSettings(ctx context.Context) types.SiteSettings {
	c := &s.siteSettingsCache
	c.mu.Lock()
	fresh := c.have && time.Since(c.at) < siteSettingsTTL
	val := c.val
	c.mu.Unlock()
	if fresh {
		return val
	}
	v, err := s.store.SiteSettings(ctx)
	if err != nil {
		s.log.Warn("site settings: read", "error", err)
		if c.have {
			return val // the last good copy beats the default
		}
		return types.SiteSettings{}
	}
	out := siteSettingsOut(v.DownloadsVisible, v.UpdatedAt)
	c.put(out)
	return out
}

// handleAdminSiteSettings is GET /api/admin/site-settings (admin only, requireAdmin).
func (s *Server) handleAdminSiteSettings(w http.ResponseWriter, r *http.Request) {
	v, err := s.store.SiteSettings(r.Context())
	if err != nil {
		s.fail(w, r, "read site settings", err)
		return
	}
	httpx.JSON(w, http.StatusOK, siteSettingsOut(v.DownloadsVisible, v.UpdatedAt))
}

// handleAdminSetSiteSettings is PUT /api/admin/site-settings (admin only, requireAdmin).
func (s *Server) handleAdminSetSiteSettings(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	var body types.SetSiteSettingsRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	v, err := s.store.SetSiteSettings(r.Context(), body.DownloadsVisible, admin.ID)
	if err != nil {
		s.fail(w, r, "set site settings", err)
		return
	}
	out := siteSettingsOut(v.DownloadsVisible, v.UpdatedAt)
	s.siteSettingsCache.put(out)
	s.logAdminAction(admin.ID, "site settings", "", "downloads_visible", v.DownloadsVisible)
	httpx.JSON(w, http.StatusOK, out)
}

func siteSettingsOut(downloadsVisible bool, at time.Time) types.SiteSettings {
	out := types.SiteSettings{DownloadsVisible: downloadsVisible}
	if !at.IsZero() {
		out.UpdatedAt = at.UTC().Format(time.RFC3339)
	}
	return out
}
