package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/integrations"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/streamdest"
	"github.com/netkumar/webcast/api/types"
)

/* LinkedIn, Instagram and Facebook Live (integrations.RTMPPlatforms).
 *
 * The host saves a platform's Stream URL and key — on the Settings card or from
 * the room's button (PUT /api/host/integrations/{card}). Every webinar they then
 * take live pushes the mix there too, from the compositor already encoding it:
 * mixDestinations adds the URLs, so going live, the recording takeover and the
 * sweeper all carry them without knowing which platforms exist. In a room the
 * host can pause one platform for that webinar (PATCH /webinars/{slug}/{id}). */

// mountStreamDestinations registers the save/remove routes for every platform.
func (s *Server) mountStreamDestinations(r chi.Router) {
	for _, p := range integrations.RTMPPlatforms {
		p := p
		r.Put("/integrations/"+p.CardID, func(w http.ResponseWriter, r *http.Request) { s.handleSaveStreamDestination(w, r, p) })
		r.Delete("/integrations/"+p.CardID, func(w http.ResponseWriter, r *http.Request) {
			s.changeStreamDestination(w, r, userFromContext(r.Context()), p, "")
		})
	}
}

// mountWebinarStreamDestinations registers the per-room status and pause routes.
func (s *Server) mountWebinarStreamDestinations(r chi.Router) {
	for _, p := range integrations.RTMPPlatforms {
		p := p
		r.Get("/"+p.ID, func(w http.ResponseWriter, r *http.Request) {
			s.writeWebinarStreamDestination(w, r, slugFromContext(r.Context()), p)
		})
		r.Patch("/"+p.ID, func(w http.ResponseWriter, r *http.Request) { s.handleSetWebinarStreamPaused(w, r, p) })
	}
}

func (s *Server) handleSaveStreamDestination(w http.ResponseWriter, r *http.Request, p integrations.RTMPPlatform) {
	user := userFromContext(r.Context())
	if !s.requireStreamOut(w, r, user.ID) {
		return
	}
	var body types.SaveStreamKeyRequest
	if err := httpx.DecodeJSON(w, r, &body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	ingest, err := streamdest.RTMPIngest(shortName(p), body.StreamURL, body.StreamKey)
	var fe *streamdest.FieldError
	if errors.As(err, &fe) {
		httpx.Fields(w, map[string]string{fe.Field: fe.Message})
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusUnprocessableEntity, "bad_stream_key", err.Error())
		return
	}
	s.changeStreamDestination(w, r, user, p, ingest)
}

// shortName is "LinkedIn" for "LinkedIn Live", for messages.
func shortName(p integrations.RTMPPlatform) string {
	switch p.ID {
	case "linkedin":
		return "LinkedIn"
	case "instagram":
		return "Instagram"
	case "facebook":
		return "Facebook"
	}
	return p.Name
}

/* changeStreamDestination saves a platform's destination and moves any room this
 * host has live onto it straight away, so a key fixed mid-webinar takes effect
 * without leaving the room. */
func (s *Server) changeStreamDestination(w http.ResponseWriter, r *http.Request, user store.User, p integrations.RTMPPlatform, ingest string) {
	ctx := r.Context()
	slugs, err := s.store.HostLiveWebinarSlugs(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "stream destination: live webinars", err)
		return
	}
	before := make(map[string]string, len(slugs))
	for _, slug := range slugs {
		if wb, err := s.store.WebinarBySlug(ctx, slug); err == nil {
			before[slug] = s.platformIngestFor(ctx, wb, p.ID)
		}
	}

	if err := s.store.SetStreamDestination(ctx, user.ID, p.ID, ingest); err != nil {
		s.fail(w, r, "stream destination: save", err)
		return
	}
	for slug, old := range before {
		s.resyncPlatform(ctx, slug, p.ID, old)
	}
	s.log.Info("stream destination updated", "platform", p.ID, "user", user.ID, "configured", ingest != "", "live_rooms", len(slugs))

	updated, err := s.store.UserByID(ctx, user.ID)
	if err != nil {
		s.fail(w, r, "stream destination: reload", err)
		return
	}
	s.writeIntegrations(w, r, updated)
}

/* resyncPlatform swaps what one live room pushes to a platform from old to
 * whatever it should push now. A no-op when nothing changed, when the room is
 * not live, or when the URL is also the room's own pasted destination or
 * another platform's — those pushes are not this platform's to remove. */
func (s *Server) resyncPlatform(ctx context.Context, slug, platform, old string) {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return
	}
	now := s.platformIngestFor(ctx, wb, platform)
	others := map[string]bool{}
	if own, on, err := s.store.WebinarStreamIngest(ctx, slug); err == nil && on && own != "" {
		others[own] = true
	}
	for _, p := range integrations.RTMPPlatforms {
		if p.ID != platform {
			if u := s.platformIngestFor(ctx, wb, p.ID); u != "" {
				others[u] = true
			}
		}
	}
	if others[old] {
		old = ""
	}
	if others[now] {
		now = ""
	}
	if old == now {
		return
	}
	sfu, err := s.sfuFor(ctx, wb)
	if err != nil {
		return
	}
	s.syncStreamDest(ctx, wb, sfu, platform, old, now)
}

func (s *Server) handleSetWebinarStreamPaused(w http.ResponseWriter, r *http.Request, p integrations.RTMPPlatform) {
	slug := slugFromContext(r.Context())
	var body types.SetWebinarStreamPausedRequest
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
		s.fail(w, r, "stream destination: load webinar", err)
		return
	}
	old := s.platformIngestFor(r.Context(), wb, p.ID)
	if err := s.store.SetWebinarStreamPaused(r.Context(), slug, p.ID, body.Paused); err != nil {
		s.fail(w, r, "stream destination: pause", err)
		return
	}
	s.resyncPlatform(r.Context(), slug, p.ID, old)
	s.log.Info("stream destination paused toggled", "platform", p.ID, "slug", slug, "paused", body.Paused)
	s.writeWebinarStreamDestination(w, r, slug, p)
}

func (s *Server) writeWebinarStreamDestination(w http.ResponseWriter, r *http.Request, slug string, p integrations.RTMPPlatform) {
	ctx := r.Context()
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "stream destination: load webinar", err)
		return
	}
	ingest, _, err := s.store.StreamDestination(ctx, wb.Host.ID, p.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.fail(w, r, "stream destination: load", err)
		return
	}
	paused, err := s.store.WebinarStreamPaused(ctx, slug, p.ID)
	if err != nil {
		s.fail(w, r, "stream destination: paused", err)
		return
	}
	out := types.WebinarStreamDestination{
		Platform:   p.ID,
		Configured: ingest != "",
		Paused:     paused,
		// A meeting never streams out (mixPlan), so it is never reported as streaming.
		Streaming: ingest != "" && !paused && wb.Status == types.StatusLive &&
			wb.Kind != types.KindSimulive && !isMeeting(wb),
	}
	if ingest != "" {
		out.Hint = streamdest.Hint(ingest)
	}
	if !paused && destFailures.platformFailed(slug, p.ID, s.platformIngestFor(ctx, wb, p.ID), time.Now()) {
		out.Refused = true
		out.Streaming = false
	}
	httpx.JSON(w, http.StatusOK, out)
}
