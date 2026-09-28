package engage

import (
	"context"
	"net/http"
	"strconv"

	"github.com/netkumar/webcast/api/internal/authctx"
	"github.com/netkumar/webcast/api/internal/httpx"
)

/* The Audience tab: engagement across webinars. The rollup (migrations/0065) is kept
 * current by the scoring hook and registrations, so this handler only reads. A host whose
 * rollup was never filled — someone from before the table existed — is backfilled once, on
 * their first visit. */
func (s *Module) handleCRMAudienceSummary(w http.ResponseWriter, r *http.Request) {
	user := authctx.User(r.Context())
	ctx := r.Context()
	has, err := s.store.HasEngagementRollup(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "crm audience: rollup", err)
		return
	}
	if !has {
		if n, err := s.store.RefreshEngagementForHost(ctx, user.ID); err != nil {
			s.fail(w, r, "crm audience: backfill", err)
			return
		} else {
			s.log.Info("audience rollup backfilled", "host", user.ID, "contacts", n)
		}
	}
	last := 6
	if v, err := strconv.Atoi(r.URL.Query().Get("last")); err == nil && v > 0 && v <= 50 {
		last = v
	}
	out, err := s.store.Audience(ctx, user.ID, last)
	if err != nil {
		s.fail(w, r, "crm audience", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// refreshAudience updates the rollup for everyone registered for a webinar just scored.
func (s *Module) refreshAudience(ctx context.Context, slug string) {
	hostID, err := s.store.HostIDFor(ctx, slug)
	if err != nil {
		s.log.Warn("audience: host for webinar", "webinar", slug, "error", err)
		return
	}
	n, err := s.store.RefreshEngagementForWebinar(ctx, hostID, slug)
	if err != nil {
		s.log.Warn("audience: refresh", "webinar", slug, "error", err)
		return
	}
	s.log.Info("audience rollup refreshed", "webinar", slug, "contacts", n)
}
