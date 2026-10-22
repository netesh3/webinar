package api

/* Presence over the API, for an attendee the video server cannot see.
 *
 * Chat, questions and raised hands all go through POST /say, which needs nothing from LiveKit.
 * So somebody whose LiveKit connection is down — a connect that has not landed yet, a network
 * that drops it, a phone mid-handoff while the SDK and the recovery ladder work at it — can
 * still chat and put a hand up. They were missing from the host's Participants panel, which
 * listed only what LiveKit reports, and a stage invite to them went out on the data channel they
 * did not have: "they can raise a hand, but I can't bring them on stage".
 *
 * Their browser polls this while it is not connected. Each poll:
 *   - records them as present (store.TouchPresence), which puts them on the host's roster for
 *     presenceWindow, marked "limited" (types.LiveParticipant.Via);
 *   - hands back an open stage invite, the offer the stage-invite packet would have carried;
 *   - says whether the host has already put them on the stage, so the browser joins again for
 *     the stage token rather than waiting out its backoff.
 *
 * Accepting is the ordinary POST /stage-invite. applyStageGrant records the grant for somebody
 * not in the room when they are reachable this way (offRoomReachable), exactly as it does for an
 * edge viewer, and the next join returns a stage token.
 *
 * Edge viewers do not use this: their event stream and beats already do all of it (edge.go). */

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/store"
	"github.com/netkumar/webcast/api/types"
)

// presenceWindow is how long one poll keeps somebody on the host's roster. The browser polls
// every 10 s while disconnected (web: lib/presence.ts), so this allows for a few lost polls.
const presenceWindow = 60 * time.Second

// What LiveParticipant.Via says about a row the video server does not list.
const (
	viaStream  = "stream"
	viaLimited = "limited"
)

// viaFor is how an API-present attendee of this webinar is connected.
func viaFor(wb types.Webinar) string {
	if wb.Delivery == types.DeliveryEdge {
		return viaStream
	}
	return viaLimited
}

// offRoomReachable reports whether somebody LiveKit does not list can still be promoted: an
// edge viewer (every one of whom is off the video server), or an attendee who polled us in
// the last presenceWindow.
func (s *Server) offRoomReachable(ctx context.Context, wb types.Webinar, identity string) bool {
	if wb.Delivery == types.DeliveryEdge {
		return true
	}
	ok, err := s.store.IsPresent(ctx, wb.ID, identity, presenceWindow)
	if err != nil {
		s.log.Warn("stage: presence lookup failed", "slug", wb.ID, "identity", identity, "error", err)
	}
	return ok
}

func (s *Server) handlePresence(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")

	var req types.PresenceRequest
	if err := httpx.DecodeJSON(w, r, &req); err != nil {
		httpx.Error(w, http.StatusBadRequest, "bad_request", "Could not read that request.")
		return
	}
	from, ok := s.resolveSender(w, r, slug, req.JoinKey)
	if !ok {
		return
	}
	// A host or panelist account is on the stage roster already; there is nothing to stand in
	// for. A promoted attendee is not (resolveSender reports them as a panelist): their
	// browser is exactly the one that needs to hear OnStage.
	if !strings.HasPrefix(from.Identity, attendeePrefix) {
		httpx.JSON(w, http.StatusOK, types.PresenceResponse{})
		return
	}

	wb, err := s.store.WebinarBySlug(r.Context(), slug)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "That webinar doesn't exist.")
		return
	}
	if err != nil {
		s.fail(w, r, "presence: load webinar", err)
		return
	}
	if removed, rerr := s.store.WasRemoved(r.Context(), slug, from.Identity); rerr == nil && removed {
		httpx.Error(w, http.StatusForbidden, "removed", "The host removed you from this webinar.")
		return
	}
	// Outside a live session there is no roster to be on and no stage to be invited to.
	if wb.Status != types.StatusLive {
		httpx.JSON(w, http.StatusOK, types.PresenceResponse{})
		return
	}

	if err := s.store.TouchPresence(r.Context(), slug, from.Identity, time.Now()); err != nil {
		s.fail(w, r, "presence", err)
		return
	}

	var out types.PresenceResponse
	if inv, open, err := s.store.PendingStageInvite(r.Context(), slug, from.Identity); err != nil {
		s.log.Warn("presence: invite lookup failed", "slug", slug, "error", err)
	} else if open {
		out.Invite = &types.PresenceInvite{AudioOnly: inv.AudioOnly, Recording: true}
	}
	if grant, err := s.store.StageGrant(r.Context(), slug, from.Identity); err == nil && grant.Granted {
		out.OnStage = true
	}
	httpx.JSON(w, http.StatusOK, out)
}
