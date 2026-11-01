package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/types"
)

/* File exports are Professional and up (types.FeatureCSVExport, migrations/0183, 2 Nov 2026):
 * registrants.csv, report.csv, attendees.csv, engagement.csv, transcript.txt and the chat as
 * CSV. The webinar's host decides; admin overrides count. What the host sees on screen is not
 * gated, only the file. Deleting one's own account is not an export and is not gated. */

const csvExportMessage = "Downloading exports is on the Professional plan and up. Everything stays on screen on your plan."

// csvExportAllowed answers 403 feature_off unless the webinar's host has csv_export.
func (s *Server) csvExportAllowed(w http.ResponseWriter, r *http.Request) bool {
	slug := slugFromContext(r.Context())
	if slug == "" {
		slug = chi.URLParam(r, "slug")
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "csv export: webinar", err)
		return false
	}
	if s.hostHas(r.Context(), wb.Host.ID, types.FeatureCSVExport) {
		return true
	}
	httpx.Error(w, http.StatusForbidden, "feature_off", csvExportMessage)
	return false
}

// requireCSVExport is csvExportAllowed as a middleware, for the export routes.
func (s *Server) requireCSVExport(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.csvExportAllowed(w, r) {
			next.ServeHTTP(w, r)
		}
	})
}
