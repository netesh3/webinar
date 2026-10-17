package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/streamdest"
	"github.com/netkumar/webcast/api/types"
)

/* LinkedIn Live.
 *
 * The host saves LinkedIn's Stream URL and key once, on the Settings card
 * (PUT /api/host/integrations/linkedin). Every webinar they then take live
 * pushes the mix to LinkedIn too, from the compositor already encoding it —
 * mixDestinations adds the URL, so going live, the recording takeover and the
 * sweeper all carry it without knowing LinkedIn exists. In a room the host can
 * pause it for that webinar only (PATCH /webinars/{slug}/linkedin). */

// handleSaveLinkedIn is PUT /api/host/integrations/linkedin.
func (s *Server) handleSaveLinkedIn(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	var body types.SaveStreamKeyRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	ingest, err := streamdest.LinkedInIngest(body.StreamURL, body.StreamKey)
	if err != nil {
		field := "streamUrl"
		if errors.Is(err, streamdest.ErrLinkedInNeedKey) {
			field = "streamKey"
		}
		msg := err.Error()
		httpx.Fields(w, map[string]string{field: strings.ToUpper(msg[:1]) + msg[1:]})
		return
	}
	s.changeLinkedIn(w, r, user, ingest)
}

// handleRemoveLinkedIn is DELETE /api/host/integrations/linkedin.
func (s *Server) handleRemoveLinkedIn(w http.ResponseWriter, r *http.Request) {
	s.changeLinkedIn(w, r, userFromContext(r.Context()), "")
}

/* changeLinkedIn saves the destination and moves any room this host has live
 * onto it straight away, so a key fixed mid-webinar takes effect without
 * leaving the room. */
func (s *Server) changeLinkedIn(w http.ResponseWriter, r *http.Request, user store.User, ingest string) {
	ctx := r.Context()
	slugs, err := s.store.HostLiveWebinarSlugs(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "linkedin: live webinars", err)
		return
	}
	before := make(map[string]string, len(slugs))
	for _, slug := range slugs {
		if wb, err := s.store.WebinarBySlug(ctx, slug); err == nil {
			before[slug] = s.linkedInIngestFor(ctx, wb)
		}
	}

	if err := s.store.SetLinkedInDestination(ctx, user.ID, ingest); err != nil {
		s.fail(w, r, "linkedin: save", err)
		return
	}
	for slug, old := range before {
		s.resyncLinkedIn(ctx, slug, old)
	}
	s.log.Info("linkedin destination updated", "user", user.ID, "configured", ingest != "", "live_rooms", len(slugs))

	updated, err := s.store.UserByID(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "linkedin: reload", err)
		return
	}
	s.writeIntegrations(w, r, updated)
}

/* resyncLinkedIn swaps what one live room pushes to LinkedIn from old to
 * whatever it should push now. A no-op when nothing changed, when the room is
 * not live, or when the URL is also the room's own pasted destination — that
 * push belongs to the Stream dialog, not to LinkedIn. */
func (s *Server) resyncLinkedIn(ctx context.Context, slug, old string) {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return
	}
	now := s.linkedInIngestFor(ctx, wb)
	if own, on, err := s.store.WebinarStreamIngest(ctx, slug); err == nil && on && own != "" {
		if old == own {
			old = ""
		}
		if now == own {
			now = ""
		}
	}
	if old == now {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	s.syncStreamDest(ctx, wb, sfu, old, now)
}

// handleWebinarLinkedIn is GET /api/host/webinars/{slug}/linkedin.
func (s *Server) handleWebinarLinkedIn(w http.ResponseWriter, r *http.Request) {
	s.writeWebinarLinkedIn(w, r, slugFromContext(r.Context()))
}

// handleSetWebinarLinkedIn is PATCH /api/host/webinars/{slug}/linkedin.
func (s *Server) handleSetWebinarLinkedIn(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())
	var body types.SetWebinarLinkedInRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "linkedin: load webinar", err)
		return
	}
	old := s.linkedInIngestFor(r.Context(), wb)
	if err := s.store.SetWebinarLinkedInPaused(r.Context(), slug, body.Paused); err != nil {
		s.fail(w, r, "linkedin: pause", err)
		return
	}
	s.resyncLinkedIn(r.Context(), slug, old)
	s.log.Info("linkedin paused toggled", "slug", slug, "paused", body.Paused)
	s.writeWebinarLinkedIn(w, r, slug)
}

func (s *Server) writeWebinarLinkedIn(w http.ResponseWriter, r *http.Request, slug string) {
	ctx := r.Context()
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "linkedin: load webinar", err)
		return
	}
	ingest, _, err := s.store.LinkedInDestination(ctx, wb.Host.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "linkedin: destination", err)
		return
	}
	paused, err := s.store.WebinarLinkedInPaused(ctx, slug)
	if err != nil {
		s.fail(w, r, "linkedin: paused", err)
		return
	}
	out := types.WebinarLinkedIn{
		Configured: ingest != "",
		Paused:     paused,
		Streaming:  ingest != "" && !paused && wb.Status == types.StatusLive && wb.Kind != types.KindSimulive,
	}
	if ingest != "" {
		out.Hint = streamdest.Hint(ingest)
	}
	httpx.JSON(w, http.StatusOK, out)
}
