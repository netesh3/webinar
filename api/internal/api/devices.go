package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/useragent"
)

/* noteJoinDevice records what this join came from (types.AudienceDevices), after the join's
 * TouchAttendance has made the row. Best effort, like that touch: a join never fails over an
 * analytics column. Only the first join's device is kept (store.SetAttendanceDevice). */
func (s *Server) noteJoinDevice(r *http.Request, slug, identity string) {
	if err := s.store.SetAttendanceDevice(r.Context(), slug, identity, useragent.Parse(r.UserAgent())); err != nil {
		s.log.Warn("join: could not record device", "slug", slug, "error", err)
	}
}

// handleWebinarDevices is one webinar's audience by device, for its host.
func (s *Server) handleWebinarDevices(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	out, err := s.store.WebinarAudienceDevices(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "audience devices", err)
		return
	}
	httpx.JSON(w, http.StatusOK, out)
}

// adminDeviceDays are the windows the admin can pick; anything else is the first.
var adminDeviceDays = []int{7, 30, 90}

// handleAdminDevices is every webinar's audience by device, for people who first joined in
// the last ?days= days.
func (s *Server) handleAdminDevices(w http.ResponseWriter, r *http.Request) {
	days := adminDeviceDays[0]
	if n, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil {
		for _, d := range adminDeviceDays {
			if n == d {
				days = d
			}
		}
	}
	out, err := s.store.AudienceDevicesSince(r.Context(), time.Now().AddDate(0, 0, -days))
	if err != nil {
		s.fail(w, r, "admin audience devices", err)
		return
	}
	out.Days = days
	httpx.JSON(w, http.StatusOK, out)
}
