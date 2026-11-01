package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/useragent"
	"github.com/netkumar/webcast/api/types"
)

/* noteJoinDevice records what this join came from (types.AudienceDevices) and where
 * (types.AudienceLocations), after the join's TouchAttendance has made the row. Best effort,
 * like that touch: a join never fails over an analytics column. Only the first join's device
 * and place are kept (store.SetAttendanceDevice). */
func (s *Server) noteJoinDevice(r *http.Request, slug, identity string) {
	if err := s.store.SetAttendanceDevice(r.Context(), slug, identity, useragent.Parse(r.UserAgent()), joinLocation(r)); err != nil {
		s.log.Warn("join: could not record device", "slug", slug, "error", err)
	}
}

/* joinLocation is where Cloudflare places this join's network, for the audience by location.
 * A country is two letters, upper case; Cloudflare's XX (no idea) and T1 (Tor) are unknown,
 * as is anything else that is not a real code. With no country there is no region or city
 * either. (29 Oct 2026) */
func joinLocation(r *http.Request) store.Location {
	c := viewerCountry(r)
	if len(c) != 2 || c == "XX" || c[0] < 'A' || c[0] > 'Z' || c[1] < 'A' || c[1] > 'Z' {
		return store.Location{}
	}
	return store.Location{Country: c, Region: viewerRegion(r), City: viewerCity(r)}
}

// handleWebinarDevices is one webinar's audience by device, for its host.
func (s *Server) handleWebinarDevices(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	if !s.audienceInsightsAllowed(w, r, slug) {
		return
	}
	out, err := s.store.WebinarAudienceDevices(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "audience devices", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* audienceInsightsAllowed refuses the device and location breakdowns, 403 feature_off, for a
 * webinar whose host's plan has no audience_insights (Professional and up, migrations/0181).
 * The webinar's host decides, as for every host feature, not the co-host reading it. */
func (s *Server) audienceInsightsAllowed(w http.ResponseWriter, r *http.Request, slug string) bool {
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "audience insights: webinar", err)
		return false
	}
	if s.hostHas(r.Context(), wb.Host.ID, types.FeatureAudienceInsights) {
		return true
	}
	httpx.Error(w, http.StatusForbidden, "feature_off",
		"Audience by device and location is on the Professional plan and up.")
	return false
}

// handleWebinarLocations is one webinar's audience by location, for its host.
func (s *Server) handleWebinarLocations(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	if !s.audienceInsightsAllowed(w, r, slug) {
		return
	}
	out, err := s.store.WebinarAudienceLocations(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "audience locations", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// adminDeviceDays are the windows the admin can pick; anything else is the first.
var adminDeviceDays = []int{7, 30, 90}

// handleAdminDevices is every webinar's audience by device, for people who first joined in
// the last ?days= days.
func (s *Server) handleAdminDevices(w http.ResponseWriter, r *http.Request) {
	days := adminDays(r)
	out, err := s.store.AudienceDevicesSince(r.Context(), time.Now().AddDate(0, 0, -days))
	if err != nil {
		s.fail(w, r, "admin audience devices", err)
		return
	}
	out.Days = days
	httpx.JSON(w, http.StatusOK, out)
}

// handleAdminLocations is every webinar's audience by location, for people who first joined
// in the last ?days= days: the same windows as the devices.
func (s *Server) handleAdminLocations(w http.ResponseWriter, r *http.Request) {
	days := adminDays(r)
	out, err := s.store.AudienceLocationsSince(r.Context(), time.Now().AddDate(0, 0, -days))
	if err != nil {
		s.fail(w, r, "admin audience locations", err)
		return
	}
	out.Days = days
	httpx.JSON(w, http.StatusOK, out)
}

// adminDays is the ?days= window asked for when it is one of adminDeviceDays, else the first.
func adminDays(r *http.Request) int {
	days := adminDeviceDays[0]
	if n, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil {
		for _, d := range adminDeviceDays {
			if n == d {
				days = d
			}
		}
	}
	return days
}
