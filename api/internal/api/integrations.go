package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/integrations"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

func (s *Server) integrationRegistry() *integrations.Registry {
	var revoke integrations.YouTubeRevoke
	oauth := s.youtube != nil && s.youtube.Enabled()
	if oauth {
		revoke = s.youtube.Revoke
	}
	return integrations.New(s.store, oauth, revoke, s.zoomHooks())
}

func (s *Server) handleListIntegrations(w http.ResponseWriter, r *http.Request) {
	s.writeIntegrations(w, r, userFromContext(r.Context()))
}

func (s *Server) handleIntegrationInterest(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	id := chi.URLParam(r, "id")
	if err := s.integrationRegistry().RecordInterest(r.Context(), user, id); err != nil {
		s.integrationError(w, r, err)
		return
	}
	s.writeIntegrations(w, r, user)
}

func (s *Server) handleIntegrationDisconnect(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	id := chi.URLParam(r, "id")
	if id == "zoom" && !s.featureAllowed(w, user, types.FeatureZoom) {
		return
	}
	if err := s.integrationRegistry().Disconnect(r.Context(), user, id); err != nil {
		s.integrationError(w, r, err)
		return
	}
	updated, err := s.store.UserByID(r.Context(), user.ID)
	if err != nil {
		s.fail(w, r, "integrations: reload", err)
		return
	}
	s.writeIntegrations(w, r, updated)
}

func (s *Server) writeIntegrations(w http.ResponseWriter, r *http.Request, user store.User) {
	cards, err := s.integrationRegistry().List(r.Context(), user)
	if err != nil {
		s.fail(w, r, "integrations", err)
		return
	}
	if cards == nil {
		cards = []types.IntegrationCard{}
	}
	httpx.JSON(w, http.StatusOK, types.IntegrationsResponse{Integrations: cards})
}

func (s *Server) integrationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, integrations.ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "unknown_integration", "That integration is not on this list.")
	case errors.Is(err, integrations.ErrManagedByCRM):
		httpx.Error(w, http.StatusUnprocessableEntity, "managed_elsewhere",
			"Disconnect WhatsApp from the card. That also stops Meta sending webhooks to this number.")
	case errors.Is(err, integrations.ErrUnavailable):
		httpx.Error(w, http.StatusUnprocessableEntity, "not_available",
			"That integration cannot be changed from here.")
	default:
		s.fail(w, r, "integrations", err)
	}
}
