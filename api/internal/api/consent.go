package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

/* handleWhatsAppConsent is GET /api/webinars/{slug}/whatsapp-consent.
 *
 * For a signed-in person about to register: the phone to prefill (typed, else the
 * one Google once gave), and whether this webinar's host may already message them on
 * WhatsApp. When not, the register page asks, per coach, every time. */
func (s *Server) handleWhatsAppConsent(w http.ResponseWriter, r *http.Request) {
	user, ok := s.optionalUser(r)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "unauthorized", "Sign in first.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), chi.URLParam(r, "slug"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "whatsapp consent: webinar", err)
		return
	}
	phone := user.Phone
	if phone == "" {
		phone = user.GooglePhone
	}
	httpx.JSON(w, http.StatusOK, types.WhatsAppConsent{
		Phone:   phone,
		OptedIn: user.Phone != "" && s.engage.WhatsAppOptedIn(r.Context(), wb.Host.ID, user.Email, user.Phone),
	})
}
