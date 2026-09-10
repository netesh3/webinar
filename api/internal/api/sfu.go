package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/netkumar/webcast/api/internal/httpx"
	"github.com/netkumar/webcast/api/internal/lk"
	"github.com/netkumar/webcast/api/types"
)

/* Which LiveKit project a webinar's room is on, and how that gets decided.
 *
 * One rule, and everything here serves it: EVERY PARTICIPANT OF ONE WEBINAR MUST REACH THE SAME
 * PROJECT. A room exists on one project; a token is signed by one project's secret. Two
 * attendees resolved to two projects are not sharing load, they are in two separate rooms that
 * cannot see or hear each other — and the symptom is a host presenting to an empty stage while
 * the audience waits in a room of their own.
 *
 * So the project is chosen ONCE, on the first join, and written to the webinar row. Every later
 * join, mute, poll and packet reads it back. Choosing per-request — even from a stable list —
 * would break the moment the list changed, which is the one thing the list is for.
 */

// sfuUnavailable is the error code an attendee sees when their webinar's project is gone from
// the configuration and the session is too far along to be moved.
const sfuUnavailable = "sfu_unavailable"

/* sfuFor resolves the room client for a webinar, pinning the project if this is the first time.
 *
 * Called by every handler that touches LiveKit. It is deliberately cheap in the common case:
 * once `wb.SFUProject` is set — which it is for all but the first join of a webinar's life — it
 * is a map lookup and no database write.
 *
 * The three cases, in the order they arise:
 *
 *   pinned and configured      the answer, immediately.
 *   not pinned                 claim one. Concurrent joins agree because the claim takes a row
 *                              lock; see store.ClaimSFUProject.
 *   pinned but NOT configured   the operator removed the project. There is no credential left
 *                              to mint a token with, so this is fatal for a live session and
 *                              recoverable for one that has not started. Handled by repin.
 */
func (s *Server) sfuFor(ctx context.Context, wb types.Webinar) (RoomManager, error) {
	_, room, _, err := s.resolveSFU(ctx, wb)
	return room, err
}

/* resolveSFU is sfuFor plus the two facts only ensureRoom needs: which project, and whether the
 * pin is brand new.
 *
 * `fresh` is the licence to fail over. A pin that did not exist a moment ago cannot have anybody
 * connected to it, so if that project then refuses the room, trying the next one splits nothing.
 * Once the pin is established, the same failover would strand whoever is already connected.
 */
func (s *Server) resolveSFU(
	ctx context.Context, wb types.Webinar,
) (project string, room RoomManager, fresh bool, err error) {
	if wb.SFUProject != "" {
		room, err := s.sfu.Get(wb.SFUProject)
		if err == nil {
			return wb.SFUProject, room, false, nil
		}
		if !errors.Is(err, lk.ErrUnknownProject) {
			return "", nil, false, err
		}
		moved, room, err := s.repin(ctx, wb, err)
		// Not fresh even though the pin just changed: a repinned webinar may be one an
		// operator is rescuing, and a failover on top of a rescue makes two moves out of
		// one problem and two lines in the log that have to be read together.
		return moved, room, false, err
	}

	candidates := s.sfu.Candidates()
	if len(candidates) == 0 {
		return "", nil, false, lk.ErrNoProject
	}

	/* The first candidate is claimed, not the "best" one.
	 *
	 * No health check here on purpose. Probing a project before pinning would put a network
	 * call in front of every first join, and it would still be a guess — the state that
	 * matters is whether the project will accept THIS room, which is only knowable by asking
	 * it to. That happens a moment later in ensureRoom, which can fail over precisely
	 * because this returned `fresh`.
	 */
	pinned, fresh, err := s.store.ClaimSFUProject(ctx, wb.ID, candidates[0])
	if err != nil {
		return "", nil, false, fmt.Errorf("claim sfu project for %s: %w", wb.ID, err)
	}
	if fresh {
		// A consequential decision, and the one an operator wants in the log when they are
		// reconciling a LiveKit bill against a list of sessions.
		s.log.Info("webinar assigned to a livekit project",
			"slug", wb.ID, "project", pinned, "candidates", candidates)
	}
	room, err = s.sfu.Get(pinned)
	// `fresh` is only true when THIS call wrote the pin; a caller that lost the race gets
	// false and therefore does not fail over out from under the winner.
	return pinned, room, fresh, err
}

/* repin handles a webinar whose project is no longer configured.
 *
 * A LIVE webinar is refused. Moving it would leave the host connected to a room on the old
 * project — which they cannot be, since the credentials are gone — while new arrivals get a room
 * on the new one, so the "fix" would be a silently broken session instead of a loud error. An
 * operator who has pulled a project out from under a live webinar needs to hear about it.
 *
 * Anything not live is moved, because nobody is connected and the alternative is a webinar that
 * can never be joined again. This is the path an operator lands on after retiring a project that
 * had future sessions scheduled against it — which is not a mistake, it is the normal end of a
 * project's life.
 */
func (s *Server) repin(
	ctx context.Context, wb types.Webinar, cause error,
) (string, RoomManager, error) {
	if wb.Status == types.StatusLive {
		s.log.Error("live webinar is pinned to a livekit project that is no longer configured",
			"slug", wb.ID, "project", wb.SFUProject, "configured", s.sfu.IDs())
		return "", nil, fmt.Errorf("live webinar %s cannot be moved: %w", wb.ID, cause)
	}

	candidates := s.sfu.Candidates()
	if len(candidates) == 0 {
		return "", nil, lk.ErrNoProject
	}
	if err := s.store.RepinSFUProject(ctx, wb.ID, candidates[0]); err != nil {
		return "", nil, fmt.Errorf("repin %s: %w", wb.ID, err)
	}
	s.log.Warn("moved a webinar off a livekit project that is no longer configured",
		"slug", wb.ID, "from", wb.SFUProject, "to", candidates[0])
	room, err := s.sfu.Get(candidates[0])
	return candidates[0], room, err
}

/* failSFU turns a resolution failure into a response.
 *
 * Its own function because six handlers need it and because the distinction it draws matters:
 * a missing project is an OPERATOR error, not a caller error, so it must not read as "you did
 * something wrong" — but it also must not read as a generic 500, because the operator reading
 * the logs needs to be pointed at the configuration rather than at the code.
 */
func (s *Server) failSFU(w http.ResponseWriter, r *http.Request, wb types.Webinar, err error) {
	switch {
	case errors.Is(err, lk.ErrNoProject):
		s.log.Error("no enabled livekit project: every one is disabled",
			"slug", wb.ID, "configured", s.sfu.IDs())
		httpx.Error(w, http.StatusServiceUnavailable, sfuUnavailable,
			"Live sessions are temporarily unavailable. Please tell the organiser.")
	case errors.Is(err, lk.ErrUnknownProject):
		httpx.Error(w, http.StatusServiceUnavailable, sfuUnavailable,
			"This webinar's media server is no longer available. Please tell the organiser.")
	default:
		s.fail(w, r, "resolve livekit project", err)
	}
}

/* sfuForSlug is sfuFor for a handler that has a slug and no loaded webinar.
 *
 * It costs a webinar read, which is why it is not used on the chat path: handleSay and the chat
 * endpoints already hold the webinar for its controls, and they pass the resolved client down
 * rather than looking it up again per message.
 *
 * Everywhere it IS used is a host clicking something — mute, remove, open a poll — where one
 * indexed read is not worth avoiding and having the project resolved from the same place as
 * everywhere else is worth a lot.
 */
func (s *Server) sfuForSlug(ctx context.Context, slug string) (RoomManager, error) {
	wb, err := s.store.WebinarBySlug(ctx, slug)
	if err != nil {
		return nil, err
	}
	return s.sfuFor(ctx, wb)
}
