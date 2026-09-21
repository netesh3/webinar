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

	savedIngest, wasOn, err := s.store.WebinarStreamIngest(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "set stream: load ingest", err)
		return
	}
	// What the compositor is pushing right now, which is nothing while the
	// stream is stopped even though the destination is still on file.
	oldIngest := ""
	if wasOn {
		oldIngest = savedIngest
	}

	/* The broadcast being stopped, read before StopWebinarStream forgets it and
	 * ended further down, once the compositor has actually let go of it. */
	ending := ""

	if body.Off {
		ending, _ = s.store.WebinarYouTubeBroadcast(r.Context(), slug)
		if err := s.store.StopWebinarStream(r.Context(), slug, body.DropWatch); err != nil {
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
		// No new key pasted, but this webinar already has one — going live
		// again after a stop should not make the host fetch it from Studio.
		case savedIngest != "":
			ingest = savedIngest
		default:
			httpx.Error(w, http.StatusUnprocessableEntity, "need_key", streamdest.ErrNeedKey.Error())
			return
		}

		if err := s.store.SetWebinarStream(r.Context(), slug, ingest, watch, ""); err != nil {
			s.fail(w, r, "set stream", err)
			return
		}
	}

	wb, err = s.store.WebinarBySlug(r.Context(), slug)
	if err != nil {
		s.fail(w, r, "set stream: reload", err)
		return
	}

	newIngest, isOn, _ := s.store.WebinarStreamIngest(r.Context(), slug)
	if !isOn {
		newIngest = ""
	}
	if sfu, err := s.sfuFor(r.Context(), wb); err == nil {
		s.syncStreamDest(r.Context(), wb, sfu, oldIngest, newIngest)
	}

	/* Only now, with the push taken down above.
	 *
	 * Completing first — which is what this did — asks YouTube to end a
	 * broadcast whose encoder is still connected and still sending. The
	 * transition is refused, so the broadcast never ends: Studio keeps showing
	 * it as live long after the host pressed Stop. Dropping the encoder first
	 * lets enableAutoStop do the work, and this becomes the backstop for when
	 * it does not. */
	s.finishYouTubeBroadcast(r.Context(), ending, wb.Host.ID)

	s.log.Info("stream dest updated", "slug", slug, "configured", newIngest != "", "off", body.Off, "via_youtube", body.ViaYouTube)
	httpx.JSON(w, http.StatusOK, wb)
}
