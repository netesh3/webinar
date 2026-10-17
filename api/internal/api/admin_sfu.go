package api

import (
	"errors"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleAdminSFUProjects is GET /api/admin/sfu-projects: the configured LiveKit projects,
 * for the per-host "Video server" select. Ids, labels and state only — the configuration
 * holds URLs, keys and secrets, and none of them leave the server. */
func (s *Server) handleAdminSFUProjects(w http.ResponseWriter, r *http.Request) {
	enabled := s.sfu.Candidates()
	out := types.SFUProjectsResponse{Projects: []types.SFUProjectOption{}}
	for _, id := range s.sfu.IDs() {
		opt := types.SFUProjectOption{ID: id, Label: id, Enabled: slices.Contains(enabled, id)}
		if p, ok := s.liveKitProjectConfig(id); ok {
			opt.Label = p.DisplayLabel()
		}
		out.Projects = append(out.Projects, opt)
	}
	httpx.JSON(w, http.StatusOK, out)
}

/* handleSetUserSFU is PATCH /api/admin/users/{id}/sfu.
 *
 * Assigns where a host's NEW webinars go. Only a configured, enabled project can be
 * assigned; "" restores the default order. Webinars already pinned never move. */
func (s *Server) handleSetUserSFU(w http.ResponseWriter, r *http.Request) {
	admin := userFromContext(r.Context())
	targetID := chi.URLParam(r, "id")

	var body types.SetUserSFURequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	if body.Project != "" && !slices.Contains(s.sfu.Candidates(), body.Project) {
		httpx.Error(w, http.StatusUnprocessableEntity, "unknown_project",
			"That video server is not configured or is not taking new webinars.")
		return
	}
	err := s.store.SetUserSFUProject(r.Context(), targetID, body.Project)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such account.")
		return
	}
	if err != nil {
		s.fail(w, r, "set user sfu project", err)
		return
	}
	s.log.Info("host video server changed", "admin", admin.ID, "target", targetID, "project", body.Project)
	httpx.JSON(w, http.StatusOK, types.SetUserSFURequest{Project: body.Project})
}

// liveKitProjectConfig is the configured project with this id, for its label.
func (s *Server) liveKitProjectConfig(id string) (config.LiveKitProject, bool) {
	for _, p := range s.cfg.LiveKitProjects {
		if p.ID == id {
			return p, true
		}
	}
	return config.LiveKitProject{}, false
}
