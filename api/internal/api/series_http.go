package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/series"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/zoom"
	"github.com/netkumar/webcast/api/types"
)

func seriesRequested(in types.WebinarInput) bool {
	return in.Kind == types.KindRecurring || in.Recurrence != nil
}

// planRecurrence checks the schedule and lists its sessions.
// A field map is returned instead of an error so the form can point at it.
func planRecurrence(in types.WebinarInput) (series.Plan, map[string]string) {
	if in.Recurrence == nil {
		return series.Plan{}, map[string]string{"recurrence": "Choose how often the series repeats."}
	}
	if in.Instant {
		return series.Plan{}, map[string]string{"recurrence": "An instant webinar is a single session."}
	}
	if zoom.IsVenue(in.Venue) {
		return series.Plan{}, map[string]string{"venue": "A recurring series runs in this app."}
	}
	if in.Kind == types.KindSimulive {
		return series.Plan{}, map[string]string{"kind": "A simulive session is a single webinar."}
	}
	startsAt, err := time.Parse(time.RFC3339, in.StartsAt)
	if err != nil {
		return series.Plan{}, map[string]string{"startsAt": "Pick a valid date and time."}
	}
	r := in.Recurrence
	plan, err := series.PlanSchedule(startsAt, in.TimeZone, series.Input{
		Pattern:  r.Pattern,
		Interval: r.Interval,
		Weekdays: r.Weekdays,
		End:      r.End,
		EndDate:  r.EndDate,
		EndCount: r.EndCount,
	})
	if err != nil {
		return series.Plan{}, map[string]string{"recurrence": err.Error()}
	}
	return plan, nil
}

// ruleFromRecurrence validates a following-edit's schedule without listing
// sessions from this one start — the store rebuilds dates from the first
// session so earlier ones stay put.
func ruleFromRecurrence(in types.WebinarInput) (series.Rule, map[string]string) {
	plan, fields := planRecurrence(in)
	if len(fields) > 0 {
		return series.Rule{}, fields
	}
	return plan.Rule, nil
}

func (s *Server) createSeriesWebinar(w http.ResponseWriter, r *http.Request, hostID string, in types.WebinarInput) (types.Webinar, bool) {
	plan, fields := planRecurrence(in)
	if len(fields) > 0 {
		httpx.Fields(w, fields)
		return types.Webinar{}, false
	}
	in.Kind = types.KindRecurring
	wb, err := s.store.CreateWebinarSeries(r.Context(), hostID, in, plan, s.cfg.DefaultMaxMeetingMin)
	if errors.Is(err, store.ErrInvalid) {
		httpx.Error(w, http.StatusUnprocessableEntity, "invalid", err.Error())
		return types.Webinar{}, false
	}
	if err != nil {
		s.fail(w, r, "create series", err)
		return types.Webinar{}, false
	}
	return wb, true
}
