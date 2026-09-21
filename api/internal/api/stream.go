package api

import (
	"errors"
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/internal/streamdest"
	"github.com/netkumar/webcast/api/internal/yt"
	"github.com/netkumar/webcast/api/types"
)

/* handleSetStream is PATCH /api/host/webinars/{slug}/stream.
 *
 * Either a pasted Studio key, or ViaYouTube which creates the live on the
 * host's connected channel. Either way we push one extra RTMP URL on the
 * compositor already encoding the attendee mix — not a second Chromium. */
func (s *Server) handleSetStream(w http.ResponseWriter, r *http.Request) {
	slug := slugFromContext(r.Context())

	var body types.SetStreamRequest
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
		s.fail(w, r, "set stream: load webinar", err)
		return
	}

	oldIngest, err := s.store.WebinarStreamIngest(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "set stream: load ingest", err)
		return
	}

	if body.Off {
		s.completeYouTubeBroadcast(r.Context(), slug, wb.Host.ID)
		if err := s.store.SetWebinarStream(r.Context(), slug, "", "", "", body.DropWatch); err != nil {
			s.fail(w, r, "set stream", err)
			return
		}
	} else if body.ViaYouTube {
		if _, _, err = s.applyYouTubeLive(r.Context(), wb, yt.Privacy(body.Privacy)); err != nil {
			if youtubeAPIError(w, err) {
				return
			}
			s.log.Warn("youtube start live", "slug", slug, "error", err)
			httpx.Error(w, http.StatusBadGateway, "youtube_live_failed",
				"Could not create the YouTube live. Check that live streaming is enabled on the channel, then try again.")
			return
		}
	} else {
		watch, err := streamdest.WatchURL(body.WatchURL)
		if errors.Is(err, streamdest.ErrNeedWatch) {
			httpx.Error(w, http.StatusUnprocessableEntity, "need_watch", err.Error())
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusUnprocessableEntity, "bad_watch", err.Error())
			return
		}

		var ingest string
		switch {
		case body.StreamKey != "" || body.IngestURL != "":
			ingest, err = streamdest.IngestURL(body.StreamKey, body.IngestURL)
			if err != nil {
				httpx.Error(w, http.StatusUnprocessableEntity, "bad_key", err.Error())
				return
			}
		case oldIngest != "":
			ingest = oldIngest
		default:
			httpx.Error(w, http.StatusUnprocessableEntity, "need_key", streamdest.ErrNeedKey.Error())
			return
		}

		if err := s.store.SetWebinarStream(r.Context(), slug, ingest, watch, "", false); err != nil {
			s.fail(w, r, "set stream", err)
			return
		}
	}

	wb, err = s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "set stream: reload", err)
		return
	}

	newIngest, _ := s.store.WebinarStreamIngest(r.Context(), slug)
	if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
		s.syncStreamDest(r.Context(), wb, sfu, oldIngest, newIngest)
	}

	s.log.Info("stream dest updated", "slug", slug, "configured", newIngest != "", "off", body.Off, "via_youtube", body.ViaYouTube)
	httpx.JSON(w, http.StatusOK, wb)
}
