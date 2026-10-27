package api

import (
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* The site-wide maintenance banner (types/site_banner.go). Turned on from Admin -> Dashboard
 * while something the whole site depends on is down: added 2026-10-27, when the DigitalOcean
 * account lock meant no webinar or meeting could start.
 *
 * Every page polls GET /api/site-banner (web/components/site-banner.tsx, once a minute), so a
 * read is cheap: one row, kept here for siteBannerTTL and dropped on every admin write, and
 * cacheable at the edge for as long. A toggle reaches every open page within about a minute. */

const siteBannerTTL = 30 * time.Second

// siteBannerCache is this process's copy of the row. The zero value is empty.
type siteBannerCache struct {
	mu   sync.Mutex
	at   time.Time
	have bool
	val  types.SiteBanner
}

func (s *Server) handleSiteBanner(w http.ResponseWriter, r *http.Request) {
	c := &s.siteBanner
	c.mu.Lock()
	fresh := c.have && time.Since(c.at) < siteBannerTTL
	val := c.val
	c.mu.Unlock()
	if !fresh {
		b, err := s.store.SiteBanner(r.Context())
		if err != nil {
			// A banner that cannot be read is no banner: never an error page over the site.
			s.log.Warn("site banner: read", "error", err)
			httpx.JSON(w, http.StatusOK, types.SiteBanner{})
			return
		}
		val = siteBannerOut(b.Enabled, b.Message, b.UpdatedAt)
		c.mu.Lock()
		c.val, c.at, c.have = val, time.Now(), true
		c.mu.Unlock()
	}
	w.Header().Set("Cache-Control", "public, max-age=30")
	httpx.JSON(w, http.StatusOK, val)
}

// handleAdminSetSiteBanner is PUT /api/admin/site-banner (admin only, requireAdmin).
func (s *Server) handleAdminSetSiteBanner(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	var body types.SetSiteBannerRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	msg := strings.TrimSpace(body.Message)
	if utf8.RuneCountInString(msg) > types.SiteBannerMaxRunes {
		httpx.Error(w, http.StatusUnprocessableEntity, "message_too_long", "Keep the message to 280 characters.")
		return
	}
	b, err := s.store.SetSiteBanner(r.Context(), body.Enabled, msg, admin.ID)
	if err != nil {
		s.fail(w, r, "set site banner", err)
		return
	}
	out := siteBannerOut(b.Enabled, b.Message, b.UpdatedAt)
	c := &s.siteBanner
	c.mu.Lock()
	c.val, c.at, c.have = out, time.Now(), true
	c.mu.Unlock()
	s.logAdminAction(admin.ID, "site banner", "", "enabled", b.Enabled)
	httpx.JSON(w, http.StatusOK, out)
}

// siteBannerOut is the wire form: the default message when the admin left it empty.
func siteBannerOut(enabled bool, message string, at time.Time) types.SiteBanner {
	if strings.TrimSpace(message) == "" {
		message = types.SiteBannerDefaultMessage
	}
	out := types.SiteBanner{Enabled: enabled, Message: message}
	if !at.IsZero() {
		out.UpdatedAt = at.UTC().Format(time.RFC3339)
	}
	return out
}
